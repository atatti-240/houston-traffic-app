"""Regression tests for the review of the routing wiring (conditions layer, planner, plans API)."""

import threading
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.adapters import build_sources
from app.adapters.base import TrainSource
from app.conditions.provider import ConditionsProvider
from app.main import create_app
from app.planner import Place, StopRequest, plan_trip
from app.recommender import recommend_departure
from app.routing.router import Router
from app.seed.synthetic import TrainEvent

MON = lambda h, m=0: datetime(2026, 9, 28, h, m)  # noqa: E731
NOW = MON(12, 0)
HOBBY_ONLY_ROAD = "I45S:i45_610s>hobby"  # the only way into Hobby on our map


@pytest.fixture
def world(trained):
    network, models, _, factory = trained
    sources = build_sources("mock", factory, 42)
    clock = {"now": NOW}
    provider = ConditionsProvider(network, models, sources, lambda: clock["now"])
    return network, sources, provider, Router(network, models, provider), clock


def place(network, node):
    n = network.nodes[node]
    return Place(n.name, n.id, n.lat, n.lng)


@pytest.fixture
def client(services):
    services.clock.set(NOW)
    with TestClient(create_app(services)) as c:
        yield c


def kinds(notes):
    return [n["kind"] for n in notes]


# --- closures are a wait, never a dead end ---------------------------------------------------


def test_short_closure_on_the_only_road_waits_instead_of_failing(world):
    network, sources, _, router, _ = world
    sources.incidents.inject(HOBBY_ONLY_ROAD, "closure", "I-45 closed at Hobby", NOW, 20)

    best, _ = router.route("downtown", "hobby", NOW)
    assert best.closure_wait_s > 0 and best.arrive_at > MON(12, 20)
    assert any("closed until about 12:20 PM" in r and "waits" in r for r in best.reasons)

    rec = recommend_departure(router, "downtown", "hobby", MON(12, 30), earliest=NOW)
    assert rec.depart_at >= NOW and rec.eta <= MON(12, 30)

    plan = plan_trip(router, place(network, "downtown"), [StopRequest(place(network, "hobby"), MON(13), MON(14))], NOW, NOW)
    assert plan.status == "ok" and MON(12, 30) <= plan.legs[0].leave_at <= MON(13)
    assert plan.legs[0].route.closure_wait_s == 0  # leaves after it reopens


def test_long_closure_is_still_routed_around_when_there_is_a_way(world):
    _, sources, _, router, _ = world
    sources.incidents.inject("I45S:gulf_ee>downtown", "closure", "Gulf Fwy closed", NOW, 60)
    route, _ = router.route("eastend", "downtown", NOW)
    assert "I45S:gulf_ee>downtown" not in route.segment_ids and route.closure_wait_s == 0


def test_plan_api_survives_a_closure(client):
    client.post("/demo/incident", json={"segment_id": HOBBY_ONLY_ROAD, "kind": "closure", "minutes": 20})
    r = client.post("/plan", json={"start": {"place": "downtown"}, "stops": [{"place": "hobby", "window_start": "13:00", "window_end": "14:00"}]})
    assert r.status_code == 201, r.text
    route = client.post("/route", json={"origin": "downtown", "destination": "hobby"}).json()["best"]
    assert route["breakdown"]["closure_wait_min"] > 0
    assert any(s["closure"] for s in route["segments"])


# --- live data describes the present -------------------------------------------------------


def test_live_blockage_does_not_leak_into_the_past(world):
    network, sources, provider, _, _ = world
    sources.trains.inject("x_telephone", MON(11, 55), 20)  # clears 12:15
    view = provider.view()
    x = network.crossings["x_telephone"]
    past = view.crossing(x, MON(10, 0))
    assert not past.live and past.source == "history"
    recent = view.crossing(x, MON(11, 50))  # inside the 15-min tolerance: counts, from now
    assert recent.live and recent.expected_delay_s == pytest.approx(15 * 60) and recent.clears_at == MON(12, 15)


def test_live_traffic_and_incidents_do_not_leak_into_the_past(world):
    network, sources, provider, _, _ = world
    from app.conditions.live import LiveTraffic

    seg = network.segments["I45S:gulf_ee>downtown"]
    sources.live_traffic.inject(LiveTraffic(seg.id, 0.95, "camera", NOW))
    sources.incidents.inject(seg.id, "crash", "Crash", NOW, 30)
    view = provider.view()
    morning = view.segment(seg, MON(8, 0))
    assert morning.live_weight == 0 and morning.incident is None
    assert view.segment(seg, NOW).incident is not None


def test_map_scrubbed_back_shows_predictions_not_live(client):
    client.post("/demo/block-crossing", json={"crossing_id": "x_telephone", "minutes": 20})
    client.post("/demo/incident", json={"segment_id": "I45S:gulf_ee>downtown", "kind": "crash"})
    earlier = client.get("/crossings", params={"at": "2026-09-28T09:00:00"}).json()["crossings"]
    tel = next(c for c in earlier if c["id"] == "x_telephone")
    assert tel["live_blocked_until"] is None and not tel["live"]
    assert client.get("/scores/congestion", params={"at": "2026-09-28T09:00:00"}).json()["incidents"] == {}
    now = next(c for c in client.get("/crossings").json()["crossings"] if c["id"] == "x_telephone")
    assert now["live_blocked_until"] == "2026-09-28T12:20:00"


# --- confidence -----------------------------------------------------------------------------


def test_incident_feed_down_lowers_confidence_and_adds_margin(world):
    _, sources, _, router, _ = world
    sources.incidents.down = True
    rec = recommend_departure(router, "downtown", "galleria", MON(12, 25), earliest=NOW)
    assert rec.route.confidence == "low" and rec.confidence_label == "low"
    assert rec.depart_at - rec.leave_at_safe == timedelta(minutes=10) or rec.leave_at_safe == NOW


def test_default_crossing_status_is_observed_now_not_when_the_train_arrived(world):
    network, _, provider, _, _ = world

    class OnlyBlockages(TrainSource):
        def crossing_events(self, day):
            return []

        def active_blockages(self, now):
            return [TrainEvent("x_telephone", MON(11, 44), MON(12, 14))]

    provider.sources.trains = OnlyBlockages()
    cc = provider.view().crossing(network.crossings["x_telephone"], MON(12, 2))
    assert cc.live and cc.block_probability == 1.0 and cc.sensor_up and cc.confidence == "high"


# --- planner ----------------------------------------------------------------------------------


def test_end_only_windows_do_not_idle_you_into_being_late(world):
    network, _, _, router, _ = world
    stops = [
        StopRequest(place(network, "midtown"), fixed_order=True),
        StopRequest(place(network, "medcenter"), None, MON(13, 0), fixed_order=True),
        StopRequest(place(network, "hobby"), None, MON(13, 5), fixed_order=True),
    ]
    plan = plan_trip(router, place(network, "downtown"), stops, NOW, NOW)
    assert plan.status == "ok"
    for leg in plan.legs[1:]:
        assert leg.leave_at == leg.ready_at  # no waiting around at the previous stop


def test_window_hours_away_gets_a_departure_near_it(world):
    network, _, _, router, _ = world
    plan = plan_trip(router, place(network, "downtown"), [StopRequest(place(network, "galleria"), MON(18), MON(18, 30))], NOW, NOW)
    leg = plan.legs[0]
    assert MON(17, 15) <= leg.leave_at <= MON(18) and leg.wait_min < 15 and plan.status == "ok"


def test_refine_tries_every_5_min_around_the_best_15_min_slot(world):
    network, _, _, router, clock = world
    clock["now"] = MON(8, 30)
    plan = plan_trip(
        router, place(network, "heights"), [StopRequest(place(network, "greenspoint"), None, MON(9, 16))], MON(8, 30), MON(8, 30)
    )
    assert plan.legs[0].leave_at == MON(8, 55)


# --- watched plans ----------------------------------------------------------------------------


def test_failed_replan_keeps_the_leave_now_alert(client, monkeypatch):
    import app.notifications.scheduler as scheduler

    plan = client.post("/plan", json={"start": {"place": "downtown"}, "depart_after": "12:20", "stops": [{"place": "medcenter"}], "watch": True}).json()

    def boom(*a, **k):
        raise RuntimeError("planner exploded")

    monkeypatch.setattr(scheduler, "plan_trip", boom)
    r = client.post("/demo/advance-clock", json={"to": plan["legs"][0]["leave_at"]}).json()
    assert kinds(r["notifications"]) == ["leave_now"]


def test_departure_pushed_back_at_the_last_minute_says_hold_on(client):
    plan = client.post("/plan", json={"start": {"place": "downtown"}, "depart_after": "12:20", "stops": [{"place": "hobby"}], "watch": True}).json()
    assert plan["legs"][0]["leave_at"] == "2026-09-28T12:20:00"
    # The only road into Hobby closes right at 12:20 for 30 min (unknown until then).
    client.post("/demo/incident", json={"segment_id": HOBBY_ONLY_ROAD, "kind": "closure", "minutes": 30, "start": "2026-09-28T12:20:00"})
    r = client.post("/demo/advance-clock", json={"to": "2026-09-28T12:20:00"}).json()
    assert kinds(r["notifications"]) == ["leave_later"]
    assert r["notifications"][0]["title"].startswith("Hold on: leave at")
    new_leave = client.get(f"/plan/{plan['plan_id']}").json()["legs"][0]["leave_at"]
    assert new_leave > "2026-09-28T12:20:00"
    r = client.post("/demo/advance-clock", json={"to": new_leave}).json()
    assert kinds(r["notifications"]) == ["leave_now"]


def test_clock_jump_past_the_windows_expires_the_plan_quietly(client):
    req = {
        "start": {"place": "downtown"},
        "stops": [
            {"place": "medcenter", "window_start": "13:30", "window_end": "14:00", "dwell_min": 30},
            {"place": "galleria", "window_start": "15:00", "window_end": "15:30"},
        ],
        "watch": True,
    }
    plan = client.post("/plan", json=req).json()
    r = client.post("/demo/advance-clock", json={"to": "2026-09-29T07:15:00"}).json()
    assert kinds(r["notifications"]) == ["info"] and r["notifications"][0]["title"].startswith("Missed")
    assert client.get(f"/plan/{plan['plan_id']}").json()["done"] is True
    assert client.post("/demo/advance-clock", json={"minutes": 15}).json()["notifications"] == []


def test_concurrent_ticks_send_one_leave_now(client, services):
    client.post("/plan", json={"start": {"place": "downtown"}, "stops": [{"place": "galleria"}, {"place": "medcenter"}], "depart_after": "12:20", "watch": True})
    services.clock.set(MON(12, 20))
    results: list = []
    threads = [threading.Thread(target=lambda: results.append(services.tick())) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    sent = [n.kind for batch in results for n in batch]
    assert sent.count("leave_now") == 1


# --- API input handling -----------------------------------------------------------------------


def test_clock_times_for_tomorrow_morning_roll_over(client):
    client.post("/demo/advance-clock", json={"to": "2026-09-28T22:00:00"})
    r = client.post("/plan", json={"start": {"place": "downtown"}, "depart_after": "07:30", "stops": [{"place": "medcenter", "window_start": "08:00", "window_end": "08:30"}]})
    plan = r.json()
    assert r.status_code == 201 and plan["status"] == "ok"
    assert plan["legs"][0]["leave_at"].startswith("2026-09-29T07:") and plan["legs"][0]["leave_at"] >= "2026-09-29T07:30"
    late_night = client.post("/plan", json={"start": {"place": "downtown"}, "stops": [{"place": "medcenter", "window_start": "23:30", "window_end": "00:30"}]})
    assert late_night.status_code == 201, late_night.text
    assert late_night.json()["legs"][0]["window"]["end"] == "2026-09-29T00:30:00"


def test_absurd_times_are_422_not_500(client):
    assert client.get("/scores/congestion", params={"at": "0001-01-01T00:00:00+05:00"}).status_code == 422
    assert client.post("/plan", json={"start": {"place": "downtown"}, "depart_after": "9999-12-31T23:00:00", "stops": [{"place": "hobby"}]}).status_code == 422
    assert client.post("/route", json={"origin": "downtown", "destination": "hobby", "depart_at": "2030-01-01T08:00:00"}).status_code == 422


def test_live_cameras_carry_the_contract_fields(client):
    seg = next(c["segment_id"] for c in client.get("/cameras").json() if c["segment_id"])
    client.post("/demo/live-traffic", json={"segment_ids": [seg], "congestion": 0.5, "source": "camera"})
    live = client.get("/live").json()
    assert "high_injury_segments_url" in live
    cams = live["cameras"]
    assert {"vehicles", "baseline_vehicles", "congestion", "valid", "stale", "snapshot_url"} <= set(cams[0])
    labels = {c["congestion"] for c in cams}
    assert labels <= {"free", "slow", "heavy", "unknown"} and "slow" in labels
