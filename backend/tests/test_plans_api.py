"""POST /plan, GET/DELETE /plan/{id}, watched-plan alerts, GET /live and the live demo controls."""

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

CONTRACT_REQUEST = {  # docs/contracts/trip_request.json, with places on our map
    "device_id": "demo-phone-1",
    "start": {"name": "Downtown office", "lat": 29.7604, "lng": -95.3698},
    "depart_after": "2026-09-28T15:00:00-05:00",
    "stops": [
        {
            "name": "Med Center",
            "place": "medcenter",
            "window_start": "2026-09-28T16:30:00-05:00",
            "window_end": "2026-09-28T17:00:00-05:00",
            "dwell_min": 30,
            "fixed_order": False,
        },
        {
            "name": "Galleria mall",
            "lat": 29.7392,
            "lng": -95.4630,
            "window_start": "2026-09-28T17:30:00-05:00",
            "window_end": "2026-09-28T18:00:00-05:00",
            "dwell_min": 0,
            "fixed_order": False,
        },
    ],
    "safe_path": False,
    "safety_weight": 0.3,
    "buffer_min": 5,
    "watch": False,
}

LEG_KEYS = {
    "from", "to", "leave_at", "leave_at_safe", "arrive_at", "drive_min", "freeflow_min", "miles",
    "breakdown", "geometry", "hazards", "why",
}
PLAN_KEYS = {
    "plan_id", "created_at", "status", "order", "legs", "late_stops", "baseline",
    "saved_min_vs_baseline", "navigate_links", "data_freshness",
}


@pytest.fixture
def client(services):
    services.clock.set(services.clock.now().replace(hour=14, minute=55))
    with TestClient(create_app(services)) as c:
        yield c


def kinds(notes):
    return [n["kind"] for n in notes]


def test_plan_matches_the_contract(client):
    r = client.post("/plan", json=CONTRACT_REQUEST)
    assert r.status_code == 201, r.text
    plan = r.json()
    assert PLAN_KEYS <= set(plan)
    assert plan["status"] == "ok" and plan["order"] == ["Med Center", "Galleria mall"]
    for leg in plan["legs"]:
        assert LEG_KEYS <= set(leg)
        assert leg["leave_at_safe"] <= leg["leave_at"] < leg["arrive_at"]
        assert leg["geometry"] and leg["drive_min"] > 0
    first, second = plan["legs"]
    assert first["from"] == "Downtown office" and second["from"] == "Med Center"
    # -05:00 inputs come back as Houston wall-clock time; arrive inside the windows.
    assert "2026-09-28T16:00" <= first["arrive_at"] <= "2026-09-28T17:00"
    assert "2026-09-28T17:00" <= second["arrive_at"] <= "2026-09-28T18:00"
    assert plan["navigate_links"]["google"].endswith("29.7392,-95.463")
    assert plan["baseline"]["description"] and plan["data_freshness"]["feeds"]["trains"] == "up"
    assert plan["notifications"] == []  # not watched

    got = client.get(f"/plan/{plan['plan_id']}").json()
    assert got["legs"] == plan["legs"] and got["watch"] is False
    assert [p["plan_id"] for p in client.get("/plans").json()] == [plan["plan_id"]]
    assert client.delete(f"/plan/{plan['plan_id']}").status_code == 204
    assert client.get(f"/plan/{plan['plan_id']}").status_code == 404
    assert client.delete(f"/plan/{plan['plan_id']}").status_code == 404


def test_plan_validation(client):
    too_many = {**CONTRACT_REQUEST, "stops": CONTRACT_REQUEST["stops"] * 2}
    assert client.post("/plan", json=too_many).status_code == 422
    backwards = {**CONTRACT_REQUEST, "stops": [{**CONTRACT_REQUEST["stops"][0], "window_end": "2026-09-28T16:00:00-05:00"}]}
    r = client.post("/plan", json=backwards)
    assert r.status_code == 422 and "window_end" in r.json()["detail"]
    assert client.post("/plan", json={**CONTRACT_REQUEST, "start": {"name": "nowhere"}}).status_code == 422
    assert client.post("/plan", json={**CONTRACT_REQUEST, "start": {"place": "atlantis"}}).status_code == 404
    assert client.post("/plan", json={**CONTRACT_REQUEST, "safety_weight": 1.5}).status_code == 422
    assert client.post("/plan", json={**CONTRACT_REQUEST, "depart_after": "soon"}).status_code == 422


def test_watched_plan_alerts_reorder_leave_now_and_done(client):
    client.post("/demo/advance-clock", json={"to": "2026-09-28T12:00:00"})
    req = {
        "name": "Errands",
        "start": {"place": "downtown"},
        "depart_after": "12:20",
        "stops": [{"place": "galleria"}, {"place": "medcenter"}],
        "watch": True,
    }
    plan = client.post("/plan", json=req).json()
    assert plan["order"] == ["Texas Medical Center", "Galleria / Uptown"]
    assert kinds(plan["notifications"]) == ["plan"]
    assert plan["notifications"][0]["plan_id"] == plan["plan_id"]

    # A closure right on the first leg: the watched plan is re-planned immediately.
    r = client.post("/demo/incident", json={"segment_id": "I69:downtown>midtown", "kind": "closure", "minutes": 90}).json()
    assert kinds(r["notifications"]) == ["order_changed"]
    updated = client.get(f"/plan/{plan['plan_id']}").json()
    assert updated["order"] == ["Galleria / Uptown", "Texas Medical Center"]
    assert updated["created_at"] == plan["created_at"] == updated["planned_at"]  # same simulated minute

    leave0 = updated["legs"][0]["leave_at"]
    r = client.post("/demo/advance-clock", json={"to": leave0}).json()
    assert kinds(r["notifications"]) == ["leave_now"]
    assert "Galleria" in r["notifications"][0]["title"]

    leave1 = client.get(f"/plan/{plan['plan_id']}").json()["legs"][1]["leave_at"]
    r = client.post("/demo/advance-clock", json={"to": leave1}).json()
    assert kinds(r["notifications"]) == ["leave_now"] and "Medical Center" in r["notifications"][0]["title"]

    client.post("/demo/advance-clock", json={"minutes": 90})
    assert client.get(f"/plan/{plan['plan_id']}").json()["done"] is True
    assert client.post("/demo/advance-clock", json={"minutes": 30}).json()["notifications"] == []

    # Deleting the plan removes its notifications too.
    assert client.delete(f"/plan/{plan['plan_id']}").status_code == 204
    assert all(n["plan_id"] is None for n in client.get("/notifications").json())


def test_watched_plan_that_is_due_now_skips_straight_to_leave_now(client):
    req = {"start": {"place": "downtown"}, "stops": [{"place": "galleria"}], "watch": True}
    plan = client.post("/plan", json=req).json()
    assert kinds(plan["notifications"]) == ["leave_now"]


def test_live_endpoint_and_demo_controls(client):
    fwy = "I45S:gulf_ee>downtown"
    live = client.get("/live").json()
    assert {"generated_at", "crossings", "cameras", "incidents", "travel_times", "feeds", "data_freshness"} <= set(live)
    assert all(c["status"] == "unknown" and c["sensor"] is None for c in live["crossings"])
    assert live["incidents"] == [] and live["travel_times"] == []

    client.post("/demo/block-crossing", json={"crossing_id": "x_navigation", "minutes": 12})
    client.post("/demo/crossing-sensor", json={"crossing_id": "x_cullen", "up": False})
    client.post("/demo/incident", json={"segment_id": fwy, "kind": "crash", "lanes_blocked": 2})
    client.post("/demo/live-traffic", json={"segment_ids": [fwy], "congestion": 0.9, "source": "camera", "detail": "29 vehicles vs 18 usual"})

    live = client.get("/live").json()
    by_id = {c["id"]: c for c in live["crossings"]}
    nav, cullen = by_id["x_navigation"], by_id["x_cullen"]
    assert nav["status"] == "blocked" and nav["time_to_clear_min"] == 12 and nav["p_block_now"] is None
    assert nav["sensor"] == "UP" and nav["confidence"] == "high" and nav["nearest_camera_id"]
    assert cullen["status"] == "clear" and cullen["sensor"] == "DOWN" and cullen["confidence"] == "low"
    [inc] = live["incidents"]
    assert inc["kind"] == "crash" and inc["affects_routing"] and inc["road"] and inc["clears_at"]
    [tt] = live["travel_times"]
    assert tt["segment_id"] == fwy and tt["source"] == "camera" and tt["minutes"] > tt["historical_minutes"]
    assert live["data_freshness"]["cameras_age_min"] == 0

    scores = client.get("/scores/congestion").json()
    assert scores["sources"][fwy]["source"] == "live:camera"
    assert scores["incidents"][fwy]["slowdown"] == pytest.approx(1.85)
    crossing = next(c for c in client.get("/crossings").json()["crossings"] if c["id"] == "x_cullen")
    assert crossing["sensor"] == "DOWN" and crossing["confidence"] == "low"

    client.post("/demo/feed", json={"feed": "traffic", "up": False})
    live = client.get("/live").json()
    assert live["feeds"]["traffic"]["ok"] is False and live["travel_times"] == []
    route = client.post("/route", json={"origin": "eastend", "destination": "downtown"}).json()["best"]
    assert route["feeds_down"] == ["traffic"] and route["confidence"] == "low"

    assert client.post("/demo/clear-live").json()["ok"]
    live = client.get("/live").json()
    assert live["incidents"] == [] and all(f["ok"] for f in live["feeds"].values())
    assert by_id["x_navigation"]["id"] in {c["id"] for c in live["crossings"] if c["status"] == "unknown"}


def test_demo_controls_reject_unknown_ids(client):
    assert client.post("/demo/live-traffic", json={"segment_ids": ["nope"], "congestion": 0.5}).status_code == 404
    assert client.post("/demo/incident", json={"segment_id": "nope"}).status_code == 404
    assert client.post("/demo/crossing-sensor", json={"crossing_id": "nope", "up": False}).status_code == 404
    assert client.post("/demo/feed", json={"feed": "weather", "up": False}).status_code == 422


def test_safety_weight_on_route_recommend_and_trips(client):
    body = {"origin": "hobby", "destination": "galleria", "depart_at": "2026-09-28T12:00:00"}
    fast = client.post("/route", json={**body, "safety_weight": 0}).json()["best"]
    safe = client.post("/route", json={**body, "safety_weight": 1}).json()["best"]
    legacy = client.post("/route", json={**body, "safe_path": True}).json()["best"]
    assert fast["safety_weight"] == 0 and safe["safety_weight"] == 1 and safe["safe_path"]
    assert safe["breakdown"]["crash_exposure"] < fast["breakdown"]["crash_exposure"]
    assert legacy["summary"] == safe["summary"]
    seg = safe["segments"][0]
    assert {"congestion_source", "predicted_congestion", "live_weight", "incident", "confidence"} <= set(seg)
    assert client.post("/route", json={**body, "safety_weight": -0.1}).status_code == 422

    rec = client.post("/recommend", json={"origin": "eastend", "destination": "medcenter", "arrive_by": "17:00", "safety_weight": 0.5}).json()
    assert rec["leave_at_safe"] <= rec["depart_at"] and rec["data_confidence"] in {"high", "medium", "low"}
    assert rec["route"]["safety_weight"] == 0.5

    trip = client.post("/trips", json={"origin": "eastend", "destination": "medcenter", "arrive_by": "08:30", "safety_weight": 0.7}).json()
    assert trip["safety_weight"] == 0.7
    old = client.post("/trips", json={"origin": "eastend", "destination": "medcenter", "arrive_by": "08:30", "safe_path": True}).json()
    assert old["safety_weight"] == 1.0


def test_reset_clears_plans_and_live_data(client):
    client.post("/plan", json={**CONTRACT_REQUEST, "watch": True})
    client.post("/demo/incident", json={"segment_id": "I45S:gulf_ee>downtown", "kind": "closure"})
    client.post("/demo/feed", json={"feed": "trains", "up": False})
    client.post("/demo/reset")
    assert client.get("/plans").json() == [] and client.get("/notifications").json() == []
    live = client.get("/live").json()
    assert live["incidents"] == [] and all(f["ok"] for f in live["feeds"].values())
