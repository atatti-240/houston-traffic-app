"""Where a trip to or from a point gets on and off our roads (app/directions/ends.py): both ends
are picked together, so the corridor never starts or ends behind the trip. OSRM is faked."""

import pytest
from fastapi.testclient import TestClient
from test_directions import MON, FakeOsrm, client_with, vias_in

from app.api import deps, planning
from app.directions.door import DoorDirections
from app.directions.ends import CANDIDATES, candidates, choose_ends
from app.main import create_app

EADO = {"lat": 29.7482, "lng": -95.3505}
RICE = {"lat": 29.7174, "lng": -95.4018}
MUSEUM = {"lat": 29.7230, "lng": -95.3900}
MONTROSE = {"lat": 29.7440, "lng": -95.3900}
NRG = {"lat": 29.6847, "lng": -95.4107}

PLACE_TRIPS = [
    ("downtown", "galleria"),
    ("eastend", "medcenter"),
    ("downtown", "hobby"),
    ("heights", "medcenter"),
    ("galleria", "downtown"),
    ("energy", "downtown"),
    ("greenspoint", "hobby"),
]


def old_ends(svc, origin, destination, *args, **kwargs):
    """How the ends were picked before: each on its own, the nearest node."""
    return deps.resolve_location(svc, origin), deps.resolve_location(svc, destination)


@pytest.fixture
def client(services):
    services.clock.set(MON(7, 15))
    with TestClient(create_app(services)) as c:
        yield c


def ask(client, services, path, body, fake=None):
    services.directions = DoorDirections(client_with(fake or FakeOsrm()))
    r = client.post(path, json=body)
    assert r.status_code == 200, r.text
    return r.json()


def nodes_of(route) -> set[str]:
    """The nodes a route passes (segment ids are "ROAD:from>to")."""
    return {route["origin"], route["destination"]} | {
        n for s in route["segments"] for n in s["id"].split(":", 1)[1].split(">")
    }


def test_trips_between_places_are_exactly_as_before(client, services, monkeypatch):
    for o, d in PLACE_TRIPS:
        body = {"origin": o, "destination": d}
        rec = {**body, "arrive_by": "08:30"}
        asks = (("/route?directions=true", body), ("/recommend?directions=true", rec))
        new = [ask(client, services, p, b) for p, b in asks]
        with monkeypatch.context() as m:
            m.setattr(planning, "resolve_ends", old_ends)
            old = [ask(client, services, p, b) for p, b in asks]
        assert new == old, (o, d)
        assert new[0]["best"]["origin"] == o and new[0]["best"]["destination"] == d


def test_places_never_search_for_their_ends(services, monkeypatch):
    def boom(*a, **k):
        raise AssertionError("no search for a place's node")

    monkeypatch.setattr(services.router, "best_route", boom)
    view = services.router.view()
    assert choose_ends(services.network, services.router, "downtown", "hobby", MON(7, 15), 0.0, view) == (
        "downtown",
        "hobby",
    )


def test_midtown_to_eado_no_longer_goes_up_to_downtown(client, services, monkeypatch):
    body = {"origin": "midtown", "destination": EADO}
    fake = FakeOsrm()
    new = ask(client, services, "/route?directions=true", body, fake)["best"]
    with monkeypatch.context() as m:
        m.setattr(planning, "resolve_ends", old_ends)
        old = ask(client, services, "/route?directions=true", body)["best"]
    assert "downtown" in nodes_of(old)  # the bug: up to Downtown, then back down southeast
    assert "downtown" not in nodes_of(new)
    # A short hop: straight door to door (one OSRM call, no via points), and it reaches the pin.
    assert new["segments"] == [] and len(fake.urls) == 1 and vias_in(fake.urls[0]) == 0
    assert new["directions"]["status"] == "ok"
    assert new["geometry"][-1] == pytest.approx([EADO["lat"], EADO["lng"]], abs=1e-5)
    assert new["directions"]["distance_m"] < old["directions"]["distance_m"]
    assert 0 < new["total_min"] < old["total_min"]


@pytest.mark.parametrize(
    "o,d",
    [
        ("midtown", EADO),
        (MONTROSE, EADO),
        (RICE, NRG),
        (MONTROSE, MUSEUM),
        (RICE, MUSEUM),
        (NRG, MONTROSE),
        (EADO, RICE),
        ("downtown", RICE),
        ("galleria", NRG),
        (MONTROSE, "galleria"),
        (EADO, "hobby"),
    ],
)
def test_points_around_town_are_no_longer_than_before(client, services, monkeypatch, o, d):
    body = {"origin": o, "destination": d}
    new = ask(client, services, "/route?directions=true", body)["best"]
    with monkeypatch.context() as m:
        m.setattr(planning, "resolve_ends", old_ends)
        old = ask(client, services, "/route?directions=true", body)["best"]
    assert new["directions"]["status"] == "ok" and new["total_min"] > 0
    assert new["directions"]["distance_m"] <= old["directions"]["distance_m"] + 1
    assert new["total_min"] <= old["total_min"] + 0.5


def test_a_route_from_a_nearby_node_gets_its_directions(client, services):
    # EaDo -> Hobby joins I-45 at Telephone Rd, not at Downtown (EaDo's nearest node).
    body = {"origin": EADO, "destination": "hobby"}
    routes = ask(client, services, "/route?directions=true", body)["routes"]
    assert routes[0]["origin"] != "downtown"
    for r in routes[1:]:
        patch = client.post(
            "/directions",
            json={**body, "segment_ids": [s["id"] for s in r["segments"]], "depart_at": r["depart_at"]},
        )
        assert patch.status_code == 200 and patch.json()["directions"]["status"] == "ok"
    # A path from somewhere nowhere near the point is still turned down.
    far = client.post("/directions", json={**body, "segment_ids": ["I45S:i45_610s>hobby"]})
    assert far.status_code == 422


def test_recommend_picks_the_ends_once_and_keeps_them(client, services, monkeypatch):
    calls = []
    real = planning.resolve_ends

    def spy(*args, **kwargs):
        calls.append(args[1:3])
        return real(*args, **kwargs)

    monkeypatch.setattr(planning, "resolve_ends", spy)
    fake = FakeOsrm()
    trip = {"origin": "midtown", "destination": EADO, "arrive_by": "08:30"}
    route = ask(client, services, "/recommend?directions=true", trip, fake)["route"]
    assert len(calls) == 1 and len(fake.urls) == 1  # OSRM once, for the chosen route only
    assert "downtown" not in nodes_of(route)
    assert route["geometry"][-1] == pytest.approx([EADO["lat"], EADO["lng"]], abs=1e-5)


def test_a_point_tries_a_few_nearby_nodes_and_a_place_only_its_own(services):
    net = services.network
    assert candidates(net, "downtown") == ["downtown"]
    eado = candidates(net, (EADO["lat"], EADO["lng"]))
    assert eado[0] == net.nearest_node(EADO["lat"], EADO["lng"]).id == "downtown"
    assert {"midtown", "gulf_ee"} <= set(eado) and len(eado) <= CANDIDATES
    # Far from our roads (another city): its nearest node only, as before.
    assert candidates(net, (40.7128, -74.0060)) == [net.nearest_node(40.7128, -74.0060).id]
