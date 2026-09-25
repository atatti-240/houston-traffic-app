import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def client(services):
    services.clock.set(services.clock.now().replace(hour=7, minute=15))
    with TestClient(create_app(services)) as c:
        yield c


def test_places_and_segments(client):
    places = client.get("/places").json()
    assert {"downtown", "galleria", "eastend", "medcenter"} <= {p["id"] for p in places}
    segs = client.get("/segments").json()
    assert len(segs) == 82 and len(segs[0]["geometry"]) >= 2


def test_scores_default_to_now_and_accept_at(client):
    now = client.get("/scores/congestion").json()
    assert now["at"].startswith("2026-09-28T07:15")
    night = client.get("/scores/congestion", params={"at": "2026-09-28T03:00:00"}).json()
    seg = "I45N:i45_610n>downtown"
    assert now["scores"][seg] > night["scores"][seg]
    crash = client.get("/scores/crash-risk").json()["scores"]
    assert all(0 <= v <= 1 for v in crash.values())


def test_crossings_and_cameras(client):
    body = client.get("/crossings", params={"at": "2026-09-28T07:30:00"}).json()
    cullen = next(c for c in body["crossings"] if c["id"] == "x_cullen")
    assert cullen["block_probability"] > 0.5 and cullen["live_blocked_until"] is None
    cams = client.get("/cameras").json()
    assert {c["kind"] for c in cams} == {"highway", "train"}


def test_route_by_place_and_by_latlng(client):
    r = client.post("/route", json={"origin": "eastend", "destination": "medcenter", "depart_at": "2026-09-28T07:35:00"})
    assert r.status_code == 200
    best = r.json()["best"]
    assert best["total_min"] > 0 and best["geometry"] and best["summary"]
    assert any("Cullen" in reason for reason in best["reasons"])
    # A point near the Galleria snaps to the Galleria node.
    r2 = client.post("/route", json={"origin": "downtown", "destination": {"lat": 29.7392, "lng": -95.4630}})
    assert r2.json()["best"]["destination"] == "galleria"


def test_route_unknown_place_404(client):
    assert client.post("/route", json={"origin": "atlantis", "destination": "downtown"}).status_code == 404


def test_recommend_with_hhmm(client):
    body = client.post("/recommend", json={"origin": "eastend", "destination": "medcenter", "arrive_by": "08:30"}).json()
    assert body["on_time"] and body["depart_at"] < body["arrive_by"]
    assert body["confidence_label"] in {"high", "medium", "low"}
    assert body["route"]["segments"]


def test_trips_crud(client):
    r = client.post("/trips", json={"name": "Work", "origin": "eastend", "destination": "medcenter", "arrive_by": "08:30"})
    assert r.status_code == 201
    trip = r.json()
    assert trip["days"] == [0, 1, 2, 3, 4]
    assert [t["id"] for t in client.get("/trips").json()] == [trip["id"]]
    assert client.post("/trips", json={"origin": "nope", "destination": "downtown", "arrive_by": "08:30"}).status_code == 404
    assert client.post("/trips", json={"origin": "eastend", "destination": "downtown", "arrive_by": "8am"}).status_code == 422
    assert client.delete(f"/trips/{trip['id']}").status_code == 204
    assert client.get("/trips").json() == []


def test_demo_flow_clock_block_notifications_reset(client):
    client.post("/trips", json={"name": "Work", "origin": "eastend", "destination": "medcenter", "arrive_by": "08:00"})
    r = client.post("/demo/advance-clock", json={"to": "2026-09-28T07:05:00"}).json()
    assert r["now"].startswith("2026-09-28T07:05") and [n["kind"] for n in r["notifications"]] == ["plan"]

    blocked = client.post("/demo/block-crossing", json={"crossing_id": "x_ost", "minutes": 60}).json()
    assert [n["kind"] for n in blocked["notifications"]] == ["reroute"]
    live = next(c for c in client.get("/crossings").json()["crossings"] if c["id"] == "x_ost")
    assert live["block_probability"] == 1.0 and live["live_blocked_until"]

    r = client.post("/demo/advance-clock", json={"minutes": 30}).json()
    assert r["now"].startswith("2026-09-28T07:35")
    assert [n["kind"] for n in r["notifications"]] == ["leave_now"]
    notes = client.get("/notifications").json()
    assert [n["kind"] for n in notes] == ["leave_now", "reroute", "plan"]  # newest first
    # Past the arrive-by time the trip is done for the day.
    assert client.post("/demo/advance-clock", json={"minutes": 60}).json()["notifications"] == []
    assert client.get("/notifications", params={"since_id": notes[0]["id"]}).json() == []

    assert client.post("/demo/block-crossing", json={"crossing_id": "x_nope"}).status_code == 404
    reset = client.post("/demo/reset").json()
    assert reset["now"].startswith("2026-09-28T07:15")
    assert client.get("/notifications").json() == [] and client.get("/trips").json() == []


def test_clock_endpoint_and_replay(client):
    assert client.get("/clock").json()["weekday"] == "Monday"
    r = client.post("/demo/replay", params={"days": 7}).json()
    assert r["replayed_days"] == 7 and r["scores"] > 0


def test_openapi_docs(client):
    paths = client.get("/openapi.json").json()["paths"]
    for p in ["/route", "/recommend", "/trips", "/notifications", "/demo/advance-clock", "/demo/block-crossing"]:
        assert p in paths
