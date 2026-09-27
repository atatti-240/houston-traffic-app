"""Door-to-door directions, turn-by-turn steps, lanes and route choices (app/directions).

OSRM is never called for real: a fake answers from the request itself (straight lines through
the points it was given), and each test bends that answer to what it wants to check.
"""

import socket
import threading
import time
from datetime import datetime, timedelta
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient

from app.directions import geo
from app.directions.door import Corridor, DoorDirections, Endpoint, door_timing
from app.directions.options import MAX_SHARED, SLOWER_FACTOR, SLOWER_S, route_id, route_labels, route_options, shared
from app.directions.osrm import OsrmClient, OsrmNoRoute, OsrmUnavailable
from app.directions.steps import build_steps, fmt_ref, instruction, lanes, road_name, toward
from app.main import create_app
from app.routing.router import Router

MON = lambda h, m=0: datetime(2026, 9, 28, h, m)  # noqa: E731
GALLERIA_DOOR = {"lat": 29.7390, "lng": -95.4630}


# --- a fake OSRM ---------------------------------------------------------------------------------


def _parse(url: str) -> tuple[list[list[float]], dict]:
    u = urlsplit(url)
    coords = u.path.rsplit("/", 1)[-1]
    pts = [[float(lat), float(lng)] for lng, lat in (c.split(",") for c in coords.split(";"))]
    return pts, {k: v[0] for k, v in parse_qs(u.query).items()}


def _dense(a, b, step=40.0) -> list[list[float]]:
    n = max(1, int(geo.dist_m(a, b) // step))
    return [[a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n] for i in range(n)]


def _step(kind, a, b, name="", modifier="right", **extra) -> dict:
    line = _dense(a, b) + [list(b)]
    d = sum(geo.dist_m(p, q) for p, q in zip(line, line[1:]))
    return {
        "maneuver": {
            "type": kind,
            "modifier": modifier,
            "location": [a[1], a[0]],
            "bearing_before": 0,
            "bearing_after": 90,
        },
        "name": name,
        "distance": d,
        "duration": d / 20,
        "geometry": {"type": "LineString", "coordinates": [[p[1], p[0]] for p in line]},
        "intersections": [{"location": [a[1], a[0]]}],
        **extra,
    }


def fake_route(url: str) -> dict:
    """A route straight through the requested points: one leg through silent via points when
    `waypoints` is given, else one leg per pair of points."""
    pts, q = _parse(url)
    pairs = list(zip(pts, pts[1:]))
    if "waypoints" in q:
        legs_pairs = [pairs]
    else:
        legs_pairs = [[p] for p in pairs]
    legs, coords = [], []
    for lp in legs_pairs:
        line = [p for a, b in lp for p in _dense(a, b)] + [lp[-1][1]]
        dists = [geo.dist_m(p, q_) for p, q_ in zip(line, line[1:])]
        steps = [_step("depart" if i == 0 else "turn", a, b, name=f"Road {i}") for i, (a, b) in enumerate(lp)]
        steps.append(_step("arrive", lp[-1][1], lp[-1][1], modifier="left"))
        legs.append(
            {
                "distance": sum(dists),
                "duration": sum(dists) / 20,
                "steps": steps,
                "annotation": {"distance": dists, "duration": [x / 20 for x in dists]},
            }
        )
        coords.extend(line if not coords else line[1:])
    return {
        "code": "Ok",
        "routes": [
            {
                "distance": sum(leg["distance"] for leg in legs),
                "duration": sum(leg["duration"] for leg in legs),
                "geometry": {"type": "LineString", "coordinates": [[p[1], p[0]] for p in coords]},
                "legs": legs,
            }
        ],
        "waypoints": [{"location": [p[1], p[0]], "name": "", "distance": 0.0} for p in pts],
    }


class FakeOsrm:
    """Counts calls; `tweak(n, url, body)` can change the n-th answer (0-based) or raise."""

    def __init__(self, tweak=None):
        self.urls: list[str] = []
        self.tweak = tweak

    def __call__(self, url: str, timeout: float):
        self.urls.append(url)
        body = fake_route(url)
        if self.tweak:
            out = self.tweak(len(self.urls) - 1, url, body)
            if out is not None:
                return out
        return 200, body


def client_with(fetch, **kw) -> OsrmClient:
    return OsrmClient("http://osrm.test", fetch=fetch, sleep=lambda s: None, **kw)


def vias_in(url: str) -> int:
    return len(_parse(url)[0]) - 2


@pytest.fixture
def router(trained):
    network, models, _, _ = trained
    return Router(network, models)


def segments_of(network, route):
    return [network.segments[s] for s in route.segment_ids]


def place_end(network, node) -> Endpoint:
    n = network.nodes[node]
    return Endpoint(n.lat, n.lng, False)


# --- steps: instructions, names, lanes ------------------------------------------------------------


def osrm_step(kind, modifier=None, name="", ref=None, **extra) -> dict:
    return {
        "maneuver": {"type": kind, "modifier": modifier, "location": [-95.4, 29.7], "bearing_after": 270},
        "name": name,
        "ref": ref,
        **extra,
    }


@pytest.mark.parametrize(
    "step, text",
    [
        (osrm_step("depart", name="Bagby Street"), "Head west on Bagby St"),
        (osrm_step("turn", "left", "Westheimer Road", "FM 1093"), "Turn left onto Westheimer Rd"),
        (osrm_step("turn", "slight right", "Post Oak Boulevard"), "Bear right onto Post Oak Blvd"),
        (osrm_step("turn", "sharp left", "Main Street"), "Turn sharp left onto Main St"),
        (osrm_step("turn", "right"), "Turn right"),
        (osrm_step("merge", "slight left", "Gulf Freeway", "I 45"), "Merge onto I-45 Gulf Fwy"),
        (osrm_step("merge", "slight left", "Southwest Freeway", "I 69; US 59"), "Merge onto I-69/US-59 Southwest Fwy"),
        (
            osrm_step(
                "off ramp",
                "slight right",
                exits="43A;43B",
                destinations="St Joseph Parkway, Pease Street, Emancipation Avenue",
            ),
            "Take exit 43A toward St Joseph Pkwy, Pease St",
        ),
        (
            osrm_step("off ramp", "slight left", destinations="FM 1093: Westheimer Road"),
            "Take the exit on the left toward FM-1093, Westheimer Rd",
        ),
        (osrm_step("on ramp", "slight right", destinations="I 610 West"), "Take the ramp toward I-610 West"),
        (osrm_step("on ramp", "straight", "", "TX 35"), "Take the ramp onto TX-35"),
        (
            osrm_step("fork", "slight left", destinations="Saint Joseph Parkway"),
            "Keep left at the fork toward Saint Joseph Pkwy",
        ),
        (
            osrm_step("end of road", "left", "West Dallas Street"),
            "At the end of the road, turn left onto West Dallas St",
        ),
        (osrm_step("new name", "straight", "Holcombe Boulevard"), "Continue onto Holcombe Blvd"),
        (osrm_step("continue", "uturn", "Braeswood Boulevard"), "Make a U-turn onto Braeswood Blvd"),
        (osrm_step("continue", "slight left", "Katy Freeway", "I 10"), "Keep left to stay on I-10 Katy Fwy"),
        (
            {
                **osrm_step("roundabout", "right", "Main Street"),
                "maneuver": {"type": "roundabout", "modifier": "right", "exit": 2},
            },
            "At the roundabout, take the second exit onto Main St",
        ),
        (osrm_step("arrive", "right"), "Arrive at your destination, on the right"),
        (osrm_step("arrive"), "Arrive at your destination"),
    ],
)
def test_instructions_read_plainly(step, text):
    assert instruction(step) == text


def test_road_names_and_refs():
    assert fmt_ref("I 45") == "I-45" and fmt_ref("I 69; US 59") == "I-69/US-59" and fmt_ref(None) == ""
    assert road_name("Telephone Road", "TX 35") == "Telephone Rd"  # a street reads by its name
    assert road_name("South Loop East", "I 610") == "I-610 South Loop East"
    assert road_name("", "BW 8") == "BW-8"
    assert toward("I 45 North: Dallas; Downtown", limit=3) == "I-45 North, Dallas, Downtown"


def test_lanes_only_where_they_say_something():
    turn_lanes = [{"valid": False, "indications": ["left"]}, {"valid": True, "indications": ["straight", "right"]}]
    step = {"intersections": [{"lanes": turn_lanes}, {"lanes": [{"valid": True, "indications": ["none"]}]}]}
    assert lanes(step) == turn_lanes  # the maneuver's own intersection, left to right
    assert lanes({"intersections": [{"lanes": [{"valid": True, "indications": ["none"]}] * 3}]}) is None
    assert lanes({"intersections": [{}, {"lanes": turn_lanes}]}) is None  # lanes further down the road don't count
    assert lanes({"intersections": []}) is None


def test_steps_join_legs_without_stopping_at_each():
    leg = lambda: {
        "steps": [
            osrm_step("depart", name="A Street"),
            osrm_step("turn", "left", "B Street"),
            osrm_step("arrive", "left"),
        ]
    }  # noqa: E731
    steps = build_steps([leg(), leg()])
    assert [s["maneuver"]["type"] for s in steps] == ["depart", "turn", "turn", "arrive"]
    s = steps[1]
    assert s["road"] == "B St" and s["maneuver"]["location"] == [29.7, -95.4] and "lanes" not in s
    assert set(s) == {"instruction", "distance_m", "duration_s", "maneuver", "road"}


# --- the OSRM client -------------------------------------------------------------------------------


def test_client_builds_the_request_and_spaces_calls():
    now = [100.0]
    waits: list[float] = []
    fake = FakeOsrm()
    c = OsrmClient("http://osrm.test/", fetch=fake, clock=lambda: now[0], sleep=waits.append)
    pts = [[29.76, -95.37], [29.75, -95.40], [29.74, -95.46]]
    r = c.route(pts, bearings=[None, (270, 45), None], radiuses=[None, 30, None], via_only=True, annotations=True)
    assert len(r["legs"]) == 1 and len(r["waypoints"]) == 3
    q = _parse(fake.urls[0])[1]
    assert fake.urls[0].startswith("http://osrm.test/route/v1/driving/-95.370000,29.760000;")
    assert q["waypoints"] == "0;2" and q["bearings"] == ";270,45;" and q["radiuses"] == "unlimited;30;unlimited"
    assert q["steps"] == "true" and q["overview"] == "full" and q["geometries"] == "geojson"
    c.route(pts[:2])
    assert waits == [pytest.approx(1.0)]  # one request per second
    now[0] += 10
    c.route(pts[:2])
    assert waits == [pytest.approx(1.0)] and c.calls == 3


def test_client_gives_up_on_a_long_queue():
    c = OsrmClient("http://osrm.test", fetch=FakeOsrm(), clock=lambda: 0.0, sleep=lambda s: None, max_wait=2.0)
    for _ in range(3):
        c.route([[29.7, -95.3], [29.8, -95.4]])
    with pytest.raises(OsrmUnavailable, match="busy"):
        c.route([[29.7, -95.3], [29.8, -95.4]])


def test_client_cools_down_after_a_failure_and_fails_fast():
    now = [0.0]

    def broken(url, timeout):
        raise TimeoutError("timed out")

    fake = FakeOsrm()
    c = OsrmClient("http://osrm.test", fetch=broken, clock=lambda: now[0], sleep=lambda s: None, cooldown=60)
    with pytest.raises(OsrmUnavailable):
        c.route([[29.7, -95.3], [29.8, -95.4]])
    c.fetch = fake
    now[0] = 30
    with pytest.raises(OsrmUnavailable, match="cooling down"):
        c.route([[29.7, -95.3], [29.8, -95.4]])
    assert fake.urls == [] and c.down
    now[0] = 61
    c.route([[29.7, -95.3], [29.8, -95.4]])
    assert len(fake.urls) == 1


def test_client_errors():
    no_route = lambda url, t: (400, {"code": "NoSegment", "message": "Could not find a matching segment"})  # noqa: E731
    c = client_with(no_route)
    with pytest.raises(OsrmNoRoute, match="NoSegment"):
        c.route([[29.7, -95.3], [29.8, -95.4]])
    assert not c.down  # our request's fault, not the server's
    c = client_with(lambda url, t: (429, {}))
    with pytest.raises(OsrmUnavailable):
        c.route([[29.7, -95.3], [29.8, -95.4]])
    assert c.down
    off = OsrmClient("", fetch=FakeOsrm())
    assert not off.enabled
    with pytest.raises(OsrmUnavailable, match="turned off"):
        off.route([[29.7, -95.3], [29.8, -95.4]])


def test_tests_never_reach_the_public_router():
    assert OsrmClient().base_url == ""  # conftest turns it off


def test_unreachable_server_fails_fast():
    with socket.socket() as s:  # a port nobody listens on
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    c = OsrmClient(f"http://127.0.0.1:{port}", timeout=2.0)
    t = time.monotonic()
    with pytest.raises(OsrmUnavailable):
        c.route([[29.7, -95.3], [29.8, -95.4]])
    assert time.monotonic() - t < 2 and c.down


def test_slow_server_times_out():
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    held = []
    threading.Thread(target=lambda: held.append(srv.accept()), daemon=True).start()  # accepts, never answers
    try:
        c = OsrmClient(f"http://127.0.0.1:{srv.getsockname()[1]}", timeout=0.5)
        t = time.monotonic()
        with pytest.raises(OsrmUnavailable):
            c.route([[29.7, -95.3], [29.8, -95.4]])
        assert time.monotonic() - t < 2
    finally:
        srv.close()


# --- door to door: vias, validation, fallbacks, cache ------------------------------------------------


def test_vias_follow_our_roads_and_keep_to_the_direction_of_travel(router, trained):
    network = trained[0]
    best, _ = router.route("downtown", "galleria", MON(12))
    corr = Corridor(segments_of(network, best))
    vias = corr.vias(0, corr.length, 5000)
    assert len(vias) >= len(best.segment_ids)  # at least one per segment
    assert all(b.d - a.d > 100 for a, b in zip(vias, vias[1:]))
    for v in vias:
        at = geo.point_at(corr.line, corr.cum, v.d)
        assert geo.dist_m(at, v.point) < 1  # on the traced road
        ahead = geo.point_at(corr.line, corr.cum, v.d + 30)
        assert geo.angle_diff(v.bearing, geo.bearing(v.point, ahead)) < 30
        k = next(k for k, (s0, s1) in enumerate(corr.bounds) if s0 <= v.d <= s1)
        s0, s1 = corr.bounds[k]
        assert v.d - s0 >= 200 and s1 - v.d >= 200  # never at an interchange


def test_door_to_door_through_our_roads(router, trained):
    network = trained[0]
    best, _ = router.route("downtown", "galleria", MON(12))
    fake = FakeOsrm()
    door = DoorDirections(client_with(fake))
    o, d = place_end(network, "downtown"), Endpoint(**GALLERIA_DOOR, is_point=True)
    path = door.build(segments_of(network, best), o, d)
    assert path.status == "ok" and path.tried[-1].startswith("vias")
    assert len(fake.urls) == 1 and _parse(fake.urls[0])[1]["waypoints"].startswith("0;")
    assert geo.dist_m(path.geometry[0], o.latlng) < 1 and geo.dist_m(path.geometry[-1], d.latlng) < 1
    assert path.steps[0]["maneuver"]["type"] == "depart" and path.steps[-1]["maneuver"]["type"] == "arrive"
    assert 0 < path.join_m < path.leave_m and path.access_start_s > 0 and path.access_end_s > 0
    # Cached by endpoints + path: no second call.
    assert door.build(segments_of(network, best), o, d) is path and len(fake.urls) == 1


def test_a_via_that_makes_a_u_turn_is_dropped(router, trained):
    network = trained[0]
    best, _ = router.route("downtown", "galleria", MON(12))

    def uturn_at_second_via(n, url, body):
        if n == 0:
            st = body["routes"][0]["legs"][0]["steps"][2]  # starts at the 2nd via
            st["maneuver"]["modifier"] = "uturn"
            st["maneuver"]["type"] = "continue"

    fake = FakeOsrm(uturn_at_second_via)
    path = DoorDirections(client_with(fake)).build(
        segments_of(network, best), place_end(network, "downtown"), place_end(network, "galleria")
    )
    assert path.status == "ok" and len(fake.urls) == 2
    assert vias_in(fake.urls[1]) == vias_in(fake.urls[0]) - 1
    assert "U-turn at a via point" in path.tried[0]


def test_a_route_that_wanders_falls_back_to_the_way_on_and_off_our_roads(router, trained):
    network = trained[0]
    best, _ = router.route("downtown", "galleria", MON(12))

    def wander(n, url, body):
        if "waypoints" in url:  # both via attempts: 3x as long along our roads
            ann = body["routes"][0]["legs"][0]["annotation"]
            ann["distance"] = [x * 3 for x in ann["distance"]]

    fake = FakeOsrm(wander)
    corr = Corridor(segments_of(network, best))
    path = DoorDirections(client_with(fake)).build(
        corr.segments, place_end(network, "downtown"), Endpoint(**GALLERIA_DOOR, is_point=True)
    )
    assert path.status == "partial" and len(fake.urls) == 3
    assert vias_in(fake.urls[1]) < vias_in(fake.urls[0]) and vias_in(fake.urls[2]) == 2
    assert path.note and any(s["instruction"].startswith("Follow ") for s in path.steps)
    types = [s["maneuver"]["type"] for s in path.steps]
    assert types[0] == "depart" and types[-1] == "arrive" and types.count("arrive") == 1
    assert geo.dist_m(path.geometry[-1], [GALLERIA_DOOR["lat"], GALLERIA_DOOR["lng"]]) < 1


def test_nothing_usable_means_our_line_and_no_steps(router, trained):
    network = trained[0]
    best, _ = router.route("downtown", "galleria", MON(12))

    def lost(n, url, body):
        for leg in body["routes"][0]["legs"]:
            leg["distance"] = 99_000
            leg.get("annotation", {})["distance"] = [99_000] * len(leg.get("annotation", {}).get("distance", []))

    fake = FakeOsrm(lost)
    door = DoorDirections(client_with(fake))
    segs = segments_of(network, best)
    path = door.build(segs, place_end(network, "downtown"), place_end(network, "galleria"))
    assert path.status == "unavailable" and path.geometry is None and path.steps == [] and len(fake.urls) == 3
    door.build(segs, place_end(network, "downtown"), place_end(network, "galleria"))
    assert len(fake.urls) == 3  # the same answer would come back: remembered


def test_osrm_down_is_not_remembered_and_is_not_retried_during_the_cool_down(router, trained):
    network = trained[0]
    best, _ = router.route("downtown", "galleria", MON(12))
    now = [0.0]
    calls = []

    def down(url, timeout):
        calls.append(url)
        raise ConnectionRefusedError("refused")

    door = DoorDirections(OsrmClient("http://osrm.test", fetch=down, clock=lambda: now[0], sleep=lambda s: None))
    segs, o, d = segments_of(network, best), place_end(network, "downtown"), place_end(network, "galleria")
    path = door.build(segs, o, d)
    assert path.status == "unavailable" and len(calls) == 1
    assert door.build(segs, o, d).status == "unavailable" and len(calls) == 1  # cooling down: no call
    now[0] = 120
    door.client.fetch = FakeOsrm()
    assert door.build(segs, o, d).status == "ok"  # not cached while it was down


def test_doubling_back_is_caught_but_crossing_over_is_fine():
    east = [[29.75, -95.40 + i * 0.001] for i in range(12)]
    spur = east + [[29.75 + 0.001 * i, east[-1][1]] for i in range(1, 4)] + list(reversed(east[-8:]))
    assert geo.doubles_back(spur) is not None
    # East, north, west, then south straight across the first road (through one of its points).
    loop = [[29.75, -95.40 + i * 0.001] for i in range(6)] + [[29.75 + i * 0.001, -95.395] for i in range(1, 6)]
    loop += [[29.755, -95.395 - i * 0.001] for i in range(1, 3)] + [[29.755 - i * 0.001, -95.397] for i in range(1, 11)]
    assert [29.75, -95.397] in [[round(a, 6), round(b, 6)] for a, b in loop[:6]] + [
        [round(a, 6), round(b, 6)] for a, b in loop[13:]
    ]
    assert geo.doubles_back(loop) is None
    back_along = (
        loop[:13]
        + [[29.755 - i * 0.001, -95.397] for i in range(1, 5)]
        + [[29.75, -95.397 - i * 0.001] for i in range(1, 4)]
    )
    assert geo.doubles_back(back_along) is not None  # ... but turning back onto it is caught


def test_door_timing_counts_the_part_of_our_roads_it_drives_plus_the_way_on_and_off(router, trained):
    network = trained[0]
    best, _ = router.route("downtown", "galleria", MON(12))
    corr = Corridor(segments_of(network, best))
    path = DoorDirections(client_with(FakeOsrm())).build(
        corr.segments, place_end(network, "downtown"), Endpoint(**GALLERIA_DOOR, is_point=True)
    )
    t = door_timing(best, corr, path)
    assert t.access_s == pytest.approx(path.access_start_s + path.access_end_s)
    driven = (path.leave_m - path.join_m) / corr.length
    assert best.base_travel_s * driven * 0.5 < t.travel_s - t.access_s <= best.base_travel_s
    assert t.total_s == pytest.approx(t.travel_s + t.train_delay_s + t.closure_wait_s)
    assert t.arrive_at == best.depart_at + timedelta(seconds=t.total_s)


# --- route choices ------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "o, d, h",
    [("downtown", "galleria", 7), ("eastend", "medcenter", 7), ("hobby", "galleria", 17), ("energy", "downtown", 8)],
)
def test_up_to_three_different_routes(router, trained, o, d, h):
    network = trained[0]
    t = MON(h, 30)
    view = router.view(t)
    best, alt = router.route(o, d, t, view=view)
    routes = route_options(router, best, alt, view, router.traffic_only_route(o, d, t, view))
    assert 1 <= len(routes) <= 3 and routes[0] is best
    assert len({tuple(r.segment_ids) for r in routes}) == len(routes)
    for r in routes[1:]:
        assert r.total_s <= max(best.total_s * SLOWER_FACTOR, best.total_s + SLOWER_S)
        assert all(shared(network, r, k) <= MAX_SHARED for k in routes if k is not r)
        assert network.segments[r.segment_ids[0]].from_node == o and network.segments[r.segment_ids[-1]].to_node == d
    labels = [label for label, _ in route_labels(network, routes)]
    assert len(set(labels)) == len(labels) and all(x.startswith("via ") for x in labels)


def test_there_is_a_third_route_downtown_to_the_galleria(router):
    view = router.view(MON(7, 30))
    best, alt = router.route("downtown", "galleria", MON(7, 30), view=view)
    assert len(route_options(router, best, alt, view)) == 3


# --- the API ------------------------------------------------------------------------------------------


@pytest.fixture
def client(services):
    services.clock.set(MON(7, 15))
    with TestClient(create_app(services)) as c:
        yield c


def test_route_keeps_best_and_alternative_and_adds_routes(client):
    body = client.post("/route", json={"origin": "downtown", "destination": "galleria"}).json()
    routes = body["routes"]
    assert body["best"] == routes[0] and 1 <= len(routes) <= 3
    assert body["alternative"]["id"] and body["alternative"]["segments"]
    for r in routes:
        assert r["id"] and r["label"].startswith("via ") and r["main_road"] and isinstance(r["delay_causes"], list)
        assert "directions" not in r  # only when asked for
        for c in r["delay_causes"]:
            assert (
                c["kind"] in {"rush", "volume", "crash", "construction", "closure", "event", "weather", "train"}
                and c["minutes"] >= 1
            )


def test_route_with_directions_to_a_point_reaches_the_door(client, services):
    fake = FakeOsrm()
    services.directions = DoorDirections(client_with(fake))
    plain = client.post("/route", json={"origin": "downtown", "destination": GALLERIA_DOOR}).json()["best"]
    body = client.post("/route?directions=true", json={"origin": "downtown", "destination": GALLERIA_DOOR}).json()
    best = body["best"]
    d = best["directions"]
    assert d["status"] == "ok" and d["steps"][-1]["instruction"].startswith("Arrive") and d["access_min"]["end"] > 0
    assert best["geometry"][-1] == pytest.approx([GALLERIA_DOOR["lat"], GALLERIA_DOOR["lng"]], abs=1e-5)
    assert best["total_min"] != plain["total_min"] and best["breakdown"]["access_min"] > 0
    arrive = datetime.fromisoformat(best["depart_at"]) + timedelta(minutes=best["total_min"])
    assert abs((datetime.fromisoformat(best["arrive_at"]) - arrive).total_seconds()) < 4
    # Only the first route asks OSRM; the others wait to be asked for.
    assert len(fake.urls) == 1 and all(r["directions"]["status"] == "pending" for r in body["routes"][1:])

    alt = body["routes"][1]
    patch = client.post(
        "/directions",
        json={
            "origin": "downtown",
            "destination": GALLERIA_DOOR,
            "segment_ids": [s["id"] for s in alt["segments"]],
            "depart_at": alt["depart_at"],
        },
    ).json()
    assert patch["id"] == alt["id"] and patch["directions"]["status"] == "ok" and len(fake.urls) == 2
    again = client.post("/route?directions=true", json={"origin": "downtown", "destination": GALLERIA_DOOR}).json()
    assert again["routes"][1]["directions"]["status"] == "ok" and len(fake.urls) == 2  # from the cache now
    assert again["routes"][1]["total_min"] == patch["total_min"]


def test_between_places_directions_keep_our_times(client, services):
    services.directions = DoorDirections(client_with(FakeOsrm()))
    plain = client.post("/route", json={"origin": "downtown", "destination": "galleria"}).json()["best"]
    best = client.post("/route?directions=true", json={"origin": "downtown", "destination": "galleria"}).json()["best"]
    assert best["directions"]["status"] == "ok" and best["directions"]["access_min"] is None
    assert best["total_min"] == plain["total_min"] and best["arrive_at"] == plain["arrive_at"]
    assert best["geometry"] != plain["geometry"]


def test_directions_rejects_a_broken_path(client):
    ok = {"origin": "downtown", "destination": "galleria"}
    assert client.post("/directions", json={**ok, "segment_ids": ["I45N:downtown>i45_610n"]}).status_code == 422
    assert client.post("/directions", json={**ok, "segment_ids": ["nope"]}).status_code == 404


def test_with_osrm_unreachable_the_trip_still_comes_back_quickly(client, services):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    services.directions = DoorDirections(OsrmClient(f"http://127.0.0.1:{port}", timeout=1.0))
    t = time.monotonic()
    r = client.post("/route?directions=true", json={"origin": "downtown", "destination": GALLERIA_DOOR})
    assert r.status_code == 200 and time.monotonic() - t < 3
    best = r.json()["best"]
    assert (
        best["directions"]["status"] == "unavailable"
        and best["directions"]["steps"] == []
        and best["directions"]["note"]
    )
    assert best["geometry"] and best["total_min"] > 0


def test_recommend_door_to_door_leaves_early_enough_on_the_usual_marks(client, services):
    fake = FakeOsrm()
    services.directions = DoorDirections(client_with(fake))
    body = client.post(
        "/recommend?directions=true", json={"origin": "eastend", "destination": GALLERIA_DOOR, "arrive_by": "08:30"}
    ).json()
    depart, eta = datetime.fromisoformat(body["depart_at"]), datetime.fromisoformat(body["eta"])
    assert depart.minute % 5 == 0 and depart.second == 0
    assert body["buffer_min"] == 5 and body["eta"] == body["route"]["arrive_at"]
    assert body["on_time"] == (eta + timedelta(minutes=5) <= MON(8, 30))
    assert body["route"]["directions"]["status"] == "ok" and body["routes"][0] == body["route"]
    assert len(fake.urls) <= 2  # the chosen route (and the re-picked one), never the recommender's loop


def test_plans_and_saved_trips_never_ask_osrm(client, services):
    fake = FakeOsrm()
    services.directions = DoorDirections(client_with(fake))
    r = client.post(
        "/plan", json={"start": {"place": "downtown"}, "stops": [{"place": "galleria"}, {"place": "medcenter"}]}
    )
    assert r.status_code == 201
    client.post("/trips", json={"origin": "eastend", "destination": "medcenter", "arrive_by": "08:30"})
    client.post("/demo/advance-clock", json={"minutes": 30})
    client.post("/recommend", json={"origin": "eastend", "destination": "medcenter", "arrive_by": "08:30"})
    assert fake.urls == []


def test_route_ids_are_stable(router):
    a, _ = router.route("downtown", "galleria", MON(12))
    b, _ = router.route("downtown", "galleria", MON(12, 5))
    assert a.segment_ids == b.segment_ids and route_id(a) == route_id(b) and len(route_id(a)) == 10
