"""Share ETA links: making one, what the link shows, the re-checked ETA, expiry and limits."""

from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app import shares
from app.main import create_app
from app.shares import RateLimiter, Share

VIEW_KEYS = {
    "origin_name", "destination_name", "main_road", "miles", "geometry", "end", "depart_at", "shared_eta",
    "eta", "status", "checked", "now", "shared_at", "expires_in_min",
}


@pytest.fixture
def client(services):
    services.clock.set(datetime(2026, 9, 28, 7, 15))
    with TestClient(create_app(services)) as c:
        yield c


@pytest.fixture
def wall(monkeypatch):
    """A real-time clock the test moves by hand (expiry runs on real time)."""
    t = {"now": datetime(2026, 9, 27, 12, 0)}
    monkeypatch.setattr(shares, "wall_now", lambda: t["now"])
    return t


def _route(client, origin="downtown", destination="galleria", **extra):
    r = client.post("/route", json={"origin": origin, "destination": destination, **extra})
    assert r.status_code == 200
    return r.json()["best"]


def _share(client, route, **body):
    payload = {
        "segment_ids": [s["id"] for s in route["segments"]],
        "depart_at": route["depart_at"],
        "origin_name": "Downtown",
        "destination_name": "Galleria",
        **body,
    }
    return client.post("/shares", json=payload)


def test_share_link_shows_the_route_and_eta_and_nothing_else(client, wall):
    route = _route(client)
    r = _share(client, route)
    assert r.status_code == 201
    made = r.json()
    assert set(made) == {"id", "depart_at", "eta", "main_road", "expires_in_min"}
    assert shares.valid_id(made["id"]) and len(made["id"]) >= 22
    assert made["expires_in_min"] == 360 and made["eta"] == route["arrive_at"]

    view = client.get(f"/shares/{made['id']}").json()
    assert set(view) == VIEW_KEYS  # no segment ids, device ids or anything else
    assert view["origin_name"] == "Downtown" and view["destination_name"] == "Galleria"
    assert view["geometry"] == route["geometry"] and view["end"] == route["geometry"][-1]
    assert view["depart_at"] == route["depart_at"] and view["eta"] == view["shared_eta"] == route["arrive_at"]
    assert view["status"] == "on_the_way" and view["checked"] is True
    roads = {s["name"] for s in route["segments"]}
    assert any(name.startswith(view["main_road"]) for name in roads)
    assert view["miles"] == pytest.approx(sum(s["miles"] for s in route["segments"]), abs=0.1)


def test_ids_are_unguessable_and_unique(client, wall):
    route = _route(client)
    ids = {_share(client, route).json()["id"] for _ in range(5)}
    assert len(ids) == 5


def test_geometry_comes_from_our_road_map_not_the_client(client, wall):
    route = _route(client)
    made = _share(client, route, geometry=[[0, 0], [1, 1]], main_road="Fake Rd", eta="2030-01-01T00:00:00").json()
    view = client.get(f"/shares/{made['id']}").json()
    assert view["geometry"] == route["geometry"] and view["main_road"] != "Fake Rd"
    assert view["eta"] == route["arrive_at"]


def test_bad_routes_and_times_are_rejected(client, wall):
    route = _route(client)
    ids = [s["id"] for s in route["segments"]]
    post = lambda **b: client.post("/shares", json={"segment_ids": ids, **b})  # noqa: E731
    assert client.post("/shares", json={"segment_ids": []}).status_code == 422
    assert client.post("/shares", json={"segment_ids": ["NOPE:a>b"]}).status_code == 422
    assert client.post("/shares", json={"segment_ids": ids[::-1]}).status_code == 422  # don't join up
    assert client.post("/shares", json={"segment_ids": ids * 200}).status_code == 422  # too many
    assert client.post("/shares", json={"segment_ids": ["x" * 65]}).status_code == 422
    assert post(depart_at="2026-09-29T09:00:00").status_code == 422  # more than a day ahead
    assert post(depart_at="not a time").status_code == 422
    assert post(origin_name="x" * 201).status_code == 422
    assert post().status_code == 201


def test_names_are_cleaned_and_default_to_the_route_ends(client, wall):
    route = _route(client)
    made = _share(client, route, origin_name="  Home\n\t sweet\x00home ", destination_name="G" * 120).json()
    view = client.get(f"/shares/{made['id']}").json()
    assert view["origin_name"] == "Home sweet home" and view["destination_name"] == "G" * shares.MAX_NAME
    made = _share(client, route, origin_name="", destination_name="   ").json()
    view = client.get(f"/shares/{made['id']}").json()
    assert view["origin_name"] == "Downtown" and "Galleria" in view["destination_name"]


def test_destination_pin_near_the_end_is_kept_far_one_ignored(client, wall):
    route = _route(client)
    end = route["geometry"][-1]
    near = {"lat": end[0] + 0.01, "lng": end[1] + 0.01}
    view = client.get(f"/shares/{_share(client, route, destination=near).json()['id']}").json()
    assert view["end"] == [near["lat"], near["lng"]]
    far = {"lat": 40.7, "lng": -74.0}
    view = client.get(f"/shares/{_share(client, route, destination=far).json()['id']}").json()
    assert view["end"] == end
    assert _share(client, route, destination={"lat": 200, "lng": 0}).status_code == 422


def test_leave_time_in_the_past_means_now_and_a_later_one_is_kept(client, services, wall):
    route = _route(client)
    made = _share(client, route, depart_at="2026-09-28T06:00:00").json()
    assert made["depart_at"] == "2026-09-28T07:15:00"
    later = _share(client, route, depart_at="2026-09-28T09:30:00").json()
    view = client.get(f"/shares/{later['id']}").json()
    assert view["status"] == "not_left" and view["depart_at"] == "2026-09-28T09:30:00"
    # The ETA is for that leave time (not for leaving now).
    at_930 = _route(client, depart_at="2026-09-28T09:30:00")
    assert view["eta"] == at_930["arrive_at"]


def test_eta_is_rechecked_when_something_happens_on_the_route(client, services, wall):
    route = _route(client)
    made = _share(client, route).json()
    # A crash on the last road of the route, a few minutes into the drive.
    client.post("/demo/advance-clock", json={"minutes": 5})
    last = route["segments"][-1]["id"]
    client.post("/demo/incident", json={"segment_id": last, "kind": "crash", "minutes": 60, "lanes_blocked": 3})
    view = client.get(f"/shares/{made['id']}").json()
    assert view["checked"] is True and view["status"] == "on_the_way"
    assert view["eta"] > view["shared_eta"] == made["eta"]
    assert view["now"] == "2026-09-28T07:20:00"


def test_eta_settles_once_the_trip_is_well_over(client, services, wall):
    route = _route(client)
    made = _share(client, route).json()
    eta = datetime.fromisoformat(made["eta"])
    client.post("/demo/advance-clock", json={"to": (eta + timedelta(minutes=5)).isoformat()})
    view = client.get(f"/shares/{made['id']}").json()
    assert view["status"] == "arrived" and view["checked"] is True
    last_eta = view["eta"]
    # Later still, a crash on the route doesn't change what we said: that trip is over.
    client.post("/demo/advance-clock", json={"minutes": 60})
    client.post("/demo/incident", json={"segment_id": route["segments"][0]["id"], "kind": "closure", "minutes": 60})
    view = client.get(f"/shares/{made['id']}").json()
    assert view["status"] == "arrived" and view["checked"] is False and view["eta"] == last_eta


def test_links_expire_after_six_real_hours(client, services, wall):
    route = _route(client)
    share_id = _share(client, route).json()["id"]
    start = wall["now"]
    # Simulated time jumping (the demo) doesn't expire a link...
    client.post("/demo/advance-clock", json={"minutes": 12 * 60})
    wall["now"] = start + timedelta(hours=5, minutes=59)
    r = client.get(f"/shares/{share_id}")
    assert r.status_code == 200 and r.json()["expires_in_min"] == 1
    # ...real time does.
    wall["now"] = start + timedelta(hours=6)
    r = client.get(f"/shares/{share_id}")
    assert r.status_code == 404 and r.json()["detail"] == "This link expired"


def test_unknown_and_malformed_ids_look_expired(client, wall):
    for share_id in ["A" * 22, "abc", "x" * 65, "has space in it here!!", "%27%3B--xxxxxxxxxxxxxxxxxx"]:
        r = client.get(f"/shares/{share_id}")
        assert r.status_code == 404 and r.json()["detail"] == "This link expired"
    assert client.get("/shares/..%2F..%2Fplaces").status_code == 404


def test_expired_links_are_deleted_when_new_ones_are_made(client, services, wall):
    route = _route(client)
    old = _share(client, route).json()["id"]
    wall["now"] += timedelta(hours=7)
    new = _share(client, route).json()["id"]
    with services.session_factory() as s:
        assert s.get(Share, old) is None and s.get(Share, new) is not None


def test_storage_is_bounded_oldest_links_go_first(client, services, wall, monkeypatch):
    monkeypatch.setattr(shares, "MAX_SHARES", 3)
    route = _route(client)
    made = []
    for _ in range(5):
        made.append(_share(client, route).json()["id"])
        wall["now"] += timedelta(seconds=1)
    with services.session_factory() as s:
        assert s.scalar(select(func.count()).select_from(Share)) == 3
    assert [client.get(f"/shares/{i}").status_code for i in made] == [404, 404, 200, 200, 200]


def test_making_links_is_rate_limited_per_client(services, wall, monkeypatch):
    monkeypatch.setattr(shares, "RATE_LIMIT", 3)
    services.clock.set(datetime(2026, 9, 28, 7, 15))
    app = create_app(services)
    with TestClient(app, client=("10.0.0.1", 1234)) as a, TestClient(app, client=("10.0.0.2", 1234)) as b:
        route = _route(a)
        assert [_share(a, route).status_code for _ in range(4)] == [201, 201, 201, 429]
        assert _share(b, route).status_code == 201  # someone else still can
        # Reading links isn't limited.
        share_id = _share(b, route).json()["id"]
        assert all(a.get(f"/shares/{share_id}").status_code == 200 for _ in range(5))


def test_rate_limiter_window_and_memory_bound():
    t = {"now": 0.0}
    lim = RateLimiter(2, 60, max_keys=3, clock=lambda: t["now"])
    assert [lim.allow("a") for _ in range(3)] == [True, True, False]
    t["now"] = 61
    assert lim.allow("a")
    for key in "bcdef":
        lim.allow(key)
    assert len(lim._hits) <= 3


def test_a_link_whose_roads_are_gone_shows_the_last_eta(client, services, wall):
    route = _route(client)
    share_id = _share(client, route).json()["id"]
    with services.session_factory() as s:
        s.get(Share, share_id).segment_ids = ["GONE:a>b"]
        s.commit()
    view = client.get(f"/shares/{share_id}").json()
    assert view["checked"] is False and view["eta"] == route["arrive_at"] and view["geometry"] == route["geometry"]


def test_main_road_is_the_one_with_the_most_miles(services):
    net = services.network
    ids = ["I69:downtown>midtown", "I69:midtown>i69_610sw", "WHMR:i69_610sw>galleria"]
    shares.check_route(net, ids)
    i69 = sum(net.segments[i].length_miles for i in ids[:2])
    assert i69 > net.segments[ids[2]].length_miles
    assert shares.main_road(net, ids) == "I-69"
    assert shares.main_road(net, ids[2:]) == "Westheimer Rd"
