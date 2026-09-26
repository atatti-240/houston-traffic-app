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


# --- second review round ------------------------------------------------------------------------


def test_plans_without_end_times_never_expire_as_missed(client):
    plan = client.post("/plan", json={"start": {"place": "downtown"}, "depart_after": "12:20", "stops": [{"place": "medcenter"}], "watch": True}).json()
    assert plan["legs"][0]["leave_at"] == "2026-09-28T12:20:00"
    notes = client.post("/demo/advance-clock", json={"minutes": 15}).json()["notifications"]
    notes += client.post("/demo/advance-clock", json={"minutes": 15}).json()["notifications"]
    assert kinds(notes) == ["leave_now"]


def test_start_only_window_opening_is_not_missed(client):
    client.post("/plan", json={"start": {"place": "downtown"}, "stops": [{"place": "medcenter", "window_start": "13:00"}], "watch": True})
    notes = client.post("/demo/advance-clock", json={"to": "2026-09-28T13:00:00"}).json()["notifications"]
    assert "info" not in kinds(notes) and "leave_now" in kinds(notes)


def test_remaining_legs_still_alert_after_a_clock_jump(client):
    req = {"start": {"place": "downtown"}, "stops": [{"place": "medcenter", "dwell_min": 20, "fixed_order": True}, {"place": "galleria", "fixed_order": True}], "watch": True}
    plan = client.post("/plan", json=req).json()
    assert kinds(plan["notifications"]) == ["leave_now"]  # leg 0 is due right away
    notes = client.post("/demo/advance-clock", json={"minutes": 60}).json()["notifications"]
    assert kinds(notes) == ["leave_now"] and "Galleria" in notes[0]["title"]


def test_leave_now_uses_a_fresh_plan_even_right_after_a_replan(client):
    plan = client.post("/plan", json={"start": {"place": "downtown"}, "depart_after": "12:20", "stops": [{"place": "hobby"}], "watch": True}).json()
    client.post("/demo/incident", json={"segment_id": HOBBY_ONLY_ROAD, "kind": "closure", "minutes": 30, "start": "2026-09-28T12:18:00"})
    assert client.post("/demo/advance-clock", json={"to": "2026-09-28T12:16:00"}).json()["notifications"] == []
    notes = client.post("/demo/advance-clock", json={"to": "2026-09-28T12:20:00"}).json()["notifications"]
    assert kinds(notes) == ["leave_later"] and notes[0]["title"].startswith("Hold on")
    assert client.get(f"/plan/{plan['plan_id']}").json()["legs"][0]["leave_at"] > "2026-09-28T12:20:00"


def test_closure_without_a_clear_time_holds_once_then_says_go(client):
    client.post("/plan", json={"start": {"place": "downtown"}, "depart_after": "12:20", "stops": [{"place": "hobby"}], "watch": True})
    client.post("/demo/incident", json={"segment_id": HOBBY_ONLY_ROAD, "kind": "closure", "minutes": None, "start": "2026-09-28T12:20:00"})
    notes = []
    for _ in range(120):  # two hours, a minute at a time
        notes += client.post("/demo/advance-clock", json={"minutes": 1}).json()["notifications"]
    titles = [n["title"] for n in notes]
    assert sum(t.startswith("Hold on") for t in titles) == 1
    assert kinds(notes)[-1] == "leave_now"


def test_hhmm_windows_in_one_request_share_a_day(client):
    client.post("/demo/advance-clock", json={"to": "2026-09-28T22:00:00"})
    req = {
        "start": {"place": "downtown"},
        "stops": [
            {"place": "medcenter", "window_start": "08:00", "window_end": "08:30", "fixed_order": True},
            {"place": "galleria", "window_start": "09:00", "fixed_order": True},
        ],
    }
    plan = client.post("/plan", json=req).json()
    assert plan["legs"][1]["window"]["start"] == "2026-09-29T09:00:00"
    assert plan["legs"][1]["arrive_at"] >= "2026-09-29T08:55:00"
    single = client.post("/plan", json={"start": {"place": "downtown"}, "stops": [{"place": "medcenter", "window_start": "08:00"}]}).json()
    assert single["legs"][0]["window"]["start"] == "2026-09-29T08:00:00" and single["legs"][0]["leave_at"] > "2026-09-29T07:00"
    # A start-only window that opened earlier today is still today's.
    client.post("/demo/advance-clock", json={"to": "2026-09-29T12:20:00"})
    today = client.post("/plan", json={"start": {"place": "downtown"}, "stops": [{"place": "medcenter", "window_start": "12:00"}]}).json()
    assert today["legs"][0]["window"]["start"] == "2026-09-29T12:00:00"


def test_overnight_window_you_are_inside_counts(client):
    client.post("/demo/advance-clock", json={"to": "2026-09-29T00:05:00"})
    plan = client.post("/plan", json={"start": {"place": "downtown"}, "stops": [{"place": "medcenter", "window_start": "23:30", "window_end": "00:30"}]}).json()
    leg = plan["legs"][0]
    assert leg["window"] == {"start": "2026-09-28T23:30:00", "end": "2026-09-29T00:30:00"}
    assert leg["leave_at"] == "2026-09-29T00:05:00" and plan["status"] == "ok"


def test_depart_after_in_the_current_minute_is_now(client, services):
    services.clock.set(datetime(2026, 9, 28, 12, 20, 30))
    plan = client.post("/plan", json={"start": {"place": "downtown"}, "depart_after": "12:20", "stops": [{"place": "medcenter"}]}).json()
    assert plan["legs"][0]["leave_at"].startswith("2026-09-28T12:20")


def test_advance_clock_is_bounded(client):
    assert client.post("/demo/advance-clock", json={"minutes": 1e12}).status_code == 422
    assert client.post("/demo/advance-clock", json={"minutes": 1e9}).status_code == 422


def test_later_windowed_stop_moves_the_first_departure_instead_of_idling(world):
    network, _, _, router, _ = world
    stops = [StopRequest(place(network, "galleria"), MON(18), MON(18, 30)), StopRequest(place(network, "midtown"))]
    plan = plan_trip(router, place(network, "downtown"), stops, NOW, NOW)
    assert plan.status == "ok" and plan.legs[0].leave_at > MON(16)
    for leg in plan.legs[1:]:
        assert leg.leave_at - leg.ready_at < timedelta(minutes=30)


def test_waiting_for_a_window_never_arrives_after_it_opens(world):
    network, _, _, router, clock = world
    now = MON(15, 30)
    clock["now"] = now
    stops = [
        StopRequest(place(network, "heights"), dwell_min=10, fixed_order=True),
        StopRequest(place(network, "energy"), MON(16, 40), fixed_order=True),
        StopRequest(place(network, "midtown"), None, datetime(2026, 9, 28, 17, 5, 56), fixed_order=True),
    ]
    plan = plan_trip(router, place(network, "downtown"), stops, now, now)
    assert plan.status == "ok"
    assert plan.legs[1].arrive_at <= MON(16, 40) or plan.legs[1].leave_at == plan.legs[1].ready_at


def test_search_does_not_settle_for_a_dominated_route_at_a_closure(world):
    _, sources, _, router, clock = world
    clock["now"] = MON(17)
    sources.incidents.inject(HOBBY_ONLY_ROAD, "closure", "I-45 closed at Hobby", MON(17), 60)
    best, alt = router.route("galleria", "hobby", MON(17), safety_weight=0.5)
    assert alt is None or best.cost <= alt.cost + 1e-6


def test_recommend_does_not_say_leave_now_to_sit_at_a_closure(world):
    _, sources, _, router, _ = world
    sources.incidents.inject(HOBBY_ONLY_ROAD, "closure", "I-45 closed at Hobby", NOW, 120)
    rec = recommend_departure(router, "downtown", "hobby", MON(12, 45), earliest=NOW)
    assert not rec.on_time and rec.depart_at > MON(13, 30)
    assert rec.route.closure_wait_s < 10 * 60


def test_overlapping_closure_reports_cost_one_wait(world):
    _, sources, _, router, _ = world
    for minutes in (10, 20, 30, 40):
        sources.incidents.inject(HOBBY_ONLY_ROAD, "closure", f"closed {minutes}", NOW, minutes)
    overlapping, _ = router.route("downtown", "hobby", NOW)
    sources.incidents.clear()
    sources.incidents.inject(HOBBY_ONLY_ROAD, "closure", "closed 40", NOW, 40)
    single, _ = router.route("downtown", "hobby", NOW)
    assert overlapping.arrive_at == single.arrive_at


def test_later_leg_leaves_later_instead_of_sitting_at_a_closure(world):
    network, sources, _, router, _ = world
    sources.incidents.inject(HOBBY_ONLY_ROAD, "closure", "I-45 closed at Hobby", NOW, 90)
    stops = [
        StopRequest(place(network, "eastend"), MON(12, 15), MON(12, 30), 5, True),
        StopRequest(place(network, "hobby"), fixed_order=True),
    ]
    plan = plan_trip(router, place(network, "downtown"), stops, NOW, NOW)
    assert plan.legs[1].route.closure_wait_s < 6 * 60


# --- third review round -------------------------------------------------------------------------


def test_traffic_only_route_does_not_detour_through_trains_before_a_closure(world):
    _, sources, _, router, clock = world
    clock["now"] = MON(7)
    sources.incidents.inject(HOBBY_ONLY_ROAD, "closure", "I-45 closed at Hobby", MON(7), 60)
    naive = router.traffic_only_route("eastend", "hobby", MON(7))
    assert sum(s.miles for s in naive.segments) < 15
    best, _ = router.route("eastend", "hobby", MON(7))
    assert not any(r.startswith("Avoided Houston Ave") for r in best.reasons)


def test_plan_behind_a_long_closure_is_fast(client):
    import time

    client.post("/demo/incident", json={"segment_id": HOBBY_ONLY_ROAD, "kind": "closure", "minutes": 600})
    req = {
        "start": {"place": "downtown"},
        "safety_weight": 1,
        "stops": [{"place": "galleria", "window_end": "14:30"}, {"place": "greenspoint", "window_end": "15:00"}, {"place": "hobby"}],
        "watch": True,
    }
    t = time.perf_counter()
    assert client.post("/plan", json=req).status_code == 201
    assert time.perf_counter() - t < 5


def test_recommend_leaves_late_enough_to_skip_most_of_a_closure(world):
    _, sources, _, router, clock = world
    now = datetime(2026, 9, 28, 19, 42)
    clock["now"] = now
    sources.incidents.inject(HOBBY_ONLY_ROAD, "closure", "I-45 closed at Hobby", MON(12), 600)  # reopens 22:00
    rec = recommend_departure(router, "energy", "hobby", MON(21), earliest=now)
    assert rec.route.closure_wait_s < 5 * 60 and rec.eta > MON(22)


def test_saved_trip_deferred_past_arrive_by_still_gets_leave_now(client):
    client.post("/demo/advance-clock", json={"to": "2026-09-28T11:50:00"})
    client.post("/trips", json={"name": "Airport run", "origin": "downtown", "destination": "hobby", "arrive_by": "12:45", "days": [0]})
    client.post("/demo/incident", json={"segment_id": HOBBY_ONLY_ROAD, "kind": "closure", "minutes": 120, "start": "2026-09-28T11:50:00"})
    notes = []
    for _ in range(36):  # three hours, 5 min at a time
        notes += client.post("/demo/advance-clock", json={"minutes": 5}).json()["notifications"]
    assert "leave_now" in kinds(notes)
    plan_note = next(n for n in client.get("/notifications").json() if n["kind"] == "plan")
    assert "after 12:45 PM" in plan_note["body"]  # says it'll be late, not "Arrive by 12:45"


def test_windows_across_midnight_stay_in_order(client):
    client.post("/demo/advance-clock", json={"to": "2026-09-28T22:00:00"})
    req = {
        "start": {"place": "downtown"},
        "stops": [
            {"place": "medcenter", "window_start": "23:00", "window_end": "23:30", "fixed_order": True},
            {"place": "hobby", "window_start": "00:15", "window_end": "00:45", "fixed_order": True},
        ],
    }
    plan = client.post("/plan", json=req).json()
    assert plan["legs"][0]["window"]["start"] == "2026-09-28T23:00:00"
    assert plan["legs"][1]["window"]["start"] == "2026-09-29T00:15:00"
    assert plan["status"] == "ok"


def test_late_plan_is_not_missed_before_its_departure(client):
    client.post("/demo/incident", json={"segment_id": HOBBY_ONLY_ROAD, "kind": "closure", "minutes": 60})
    plan = client.post("/plan", json={"name": "Hobby pickup", "start": {"place": "downtown"}, "stops": [{"place": "hobby", "window_start": "12:15", "window_end": "12:40"}], "watch": True}).json()
    assert plan["status"] == "late"
    leave = plan["legs"][0]["leave_at"]
    notes = []
    for _ in range(70):
        notes += client.post("/demo/advance-clock", json={"minutes": 1}).json()["notifications"]
    assert "info" not in kinds(notes)
    assert "leave_now" in kinds(notes) and leave > "2026-09-28T12:40:00"


def test_watched_plan_order_is_stable_without_changes(client):
    client.post("/demo/advance-clock", json={"to": "2026-09-28T17:07:00"})
    req = {
        "start": {"place": "eastend"},
        "stops": [{"place": "downtown", "window_start": "19:16"}, {"place": "midtown"}, {"place": "heights", "fixed_order": True}],
        "watch": True,
    }
    client.post("/plan", json=req)
    notes = []
    for _ in range(24):  # two hours, 5 min at a time
        notes += client.post("/demo/advance-clock", json={"minutes": 5}).json()["notifications"]
    assert kinds(notes).count("order_changed") == 0


# --- fourth review round ------------------------------------------------------------------------


def test_skipping_a_closure_wait_never_makes_an_on_time_stop_late(client):
    client.post("/demo/incident", json={"segment_id": HOBBY_ONLY_ROAD, "kind": "closure", "minutes": 25, "start": "2026-09-28T11:59:00"})
    req = {
        "start": {"place": "downtown"},
        "stops": [{"place": "galleria", "fixed_order": True}, {"place": "hobby", "fixed_order": True, "window_end": "2026-09-28T12:28:04"}],
    }
    plan = client.post("/plan", json=req).json()
    assert plan["status"] == "ok" and plan["legs"][1]["arrive_at"] <= "2026-09-28T12:28:04"


def test_duplicate_stop_names_keep_the_better_order(client):
    client.post("/demo/advance-clock", json={"to": "2026-09-28T11:30:00"})
    req = {
        "start": {"place": "downtown"},
        "depart_after": "12:00",
        "stops": [{"name": "Store", "place": "galleria"}, {"name": "Store", "place": "medcenter"}],
        "watch": True,
    }
    plan = client.post("/plan", json=req).json()
    for _ in range(4):
        client.post("/demo/advance-clock", json={"minutes": 5})
    now = client.get(f"/plan/{plan['plan_id']}").json()
    assert now["order_index"] == plan["order_index"]
    assert now["legs"][-1]["arrive_at"] == plan["legs"][-1]["arrive_at"]


@pytest.mark.parametrize("closure_min", [63, 300])
def test_deferred_trip_gets_leave_now_even_at_or_long_after_arrive_by(client, closure_min):
    client.post("/demo/advance-clock", json={"to": "2026-09-28T11:50:00"})
    client.post("/trips", json={"name": "Airport run", "origin": "downtown", "destination": "hobby", "arrive_by": "12:45", "days": [0]})
    client.post("/demo/incident", json={"segment_id": HOBBY_ONLY_ROAD, "kind": "closure", "minutes": closure_min, "start": "2026-09-28T11:50:00"})
    notes = []
    for _ in range(6 * 12):  # six hours, 5 min at a time
        notes += client.post("/demo/advance-clock", json={"minutes": 5}).json()["notifications"]
    assert kinds(notes).count("leave_now") == 1


def test_unknown_end_closure_does_not_keep_a_plan_watched_forever(client):
    client.post("/demo/advance-clock", json={"to": "2026-09-28T08:30:00"})
    plan = client.post("/plan", json={"name": "To work", "start": {"place": "greenspoint"}, "depart_after": "09:00", "stops": [{"place": "downtown", "window_start": "09:30", "window_end": "10:00"}], "watch": True}).json()
    client.post("/demo/advance-clock", json={"to": "2026-09-28T08:50:00"})
    client.post("/demo/incident", json={"segment_id": "I45N:greenspoint>i45_bw8n", "kind": "closure", "minutes": None})
    for _ in range(6 * 12):
        client.post("/demo/advance-clock", json={"minutes": 5})
    assert client.get(f"/plan/{plan['plan_id']}").json()["done"] is True
    assert client.post("/demo/clear-live").json()["notifications"] == []


def test_fixed_order_windows_never_go_backwards_in_time(client):
    client.post("/demo/advance-clock", json={"to": "2026-09-28T22:00:00"})
    req = {
        "start": {"place": "downtown"},
        "stops": [
            {"name": "Breakfast drop", "place": "medcenter", "window_start": "08:00", "window_end": "08:30", "fixed_order": True},
            {"name": "Evening pickup", "place": "galleria", "window_start": "22:30", "window_end": "23:30", "fixed_order": True},
        ],
    }
    plan = client.post("/plan", json=req).json()
    assert plan["status"] == "ok"
    assert [leg["window"]["start"] for leg in plan["legs"]] == ["2026-09-29T08:00:00", "2026-09-29T22:30:00"]


def test_tight_trip_alert_does_not_say_late(client):
    client.post("/demo/advance-clock", json={"to": "2026-09-28T11:50:00"})
    client.post("/trips", json={"name": "Airport run", "origin": "downtown", "destination": "hobby", "arrive_by": "12:45", "days": [0]})
    client.post("/demo/incident", json={"segment_id": HOBBY_ONLY_ROAD, "kind": "closure", "minutes": 49, "start": "2026-09-28T11:50:00"})
    plan_note = next(n for n in client.get("/notifications").json() if n["kind"] == "plan")
    assert "less than 5 min to spare" in plan_note["body"] and "after 12:45" not in plan_note["body"]
