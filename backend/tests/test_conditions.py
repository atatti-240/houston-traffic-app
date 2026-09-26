"""Priority rules of the road-conditions layer (see app/conditions/provider.py)."""

from datetime import datetime, timedelta

import pytest

from app.adapters import build_sources
from app.conditions.live import LiveTraffic
from app.conditions.provider import ConditionsProvider
from app.recommender import recommend_departure
from app.routing.router import Router, crash_lambda, resolve_safety

MON = lambda h, m=0: datetime(2026, 9, 28, h, m)  # noqa: E731
NOW = MON(12, 0)
FREEWAY = "I45S:gulf_ee>downtown"
ARTERIAL = "NAV:eastend>downtown"


@pytest.fixture
def world(trained):
    """Trained network + models with a fresh set of mock live feeds and a frozen clock."""
    network, models, _, factory = trained
    sources = build_sources("mock", factory, 42)
    clock = {"now": NOW}
    provider = ConditionsProvider(network, models, sources, lambda: clock["now"])
    return network, models, sources, provider, Router(network, models, provider), clock


def seg(network, sid):
    return network.segments[sid]


def reading(sid, congestion, minutes_ago=0, source="camera", confidence="high", at=NOW):
    return LiveTraffic(sid, congestion, source, at - timedelta(minutes=minutes_ago), confidence)


# --- road speed ------------------------------------------------------------------------------


def test_no_live_data_means_prediction(world):
    network, models, _, provider, _, _ = world
    sc = provider.view().segment(seg(network, FREEWAY), NOW)
    assert sc.congestion_source == "history" and sc.live_weight == 0
    assert sc.congestion == pytest.approx(models.congestion.get_score(FREEWAY, NOW))
    assert sc.confidence == "medium" and not sc.closed and sc.incident is None


def test_live_traffic_blends_and_fades_out_by_30_min(world):
    network, models, sources, provider, _, _ = world
    sources.live_traffic.inject(reading(FREEWAY, 0.9))
    view = provider.view()
    now_sc = view.segment(seg(network, FREEWAY), NOW)
    mid_sc = view.segment(seg(network, FREEWAY), NOW + timedelta(minutes=15))
    late_sc = view.segment(seg(network, FREEWAY), NOW + timedelta(minutes=31))
    assert now_sc.live_weight == pytest.approx(0.8)
    assert mid_sc.live_weight == pytest.approx(0.4)
    assert late_sc.live_weight == 0 and late_sc.congestion_source == "history"
    pred = models.congestion.get_score(FREEWAY, NOW)
    assert now_sc.congestion == pytest.approx(0.8 * 0.9 + 0.2 * pred)
    assert now_sc.congestion_source == "live:camera" and now_sc.confidence == "high"
    assert now_sc.travel_s > models.congestion.get_segment_travel_time(FREEWAY, NOW)


def test_stale_readings_are_ignored_by_road_class(world):
    network, _, sources, provider, _, _ = world
    sources.live_traffic.inject(reading(FREEWAY, 0.9, minutes_ago=11))  # freeway limit 10 min
    sources.live_traffic.inject(reading(ARTERIAL, 0.9, minutes_ago=20))  # street limit 30 min
    view = provider.view()
    assert view.segment(seg(network, FREEWAY), NOW).live_weight == 0
    assert view.segment(seg(network, ARTERIAL), NOW).live_weight > 0


def test_low_confidence_reading_counts_half_and_marks_low(world):
    network, _, sources, provider, _, _ = world
    sources.live_traffic.inject(reading(FREEWAY, 0.9, confidence="low"))
    sc = provider.view().segment(seg(network, FREEWAY), NOW)
    assert sc.live_weight == pytest.approx(0.4)
    assert sc.confidence == "low"


def test_multiple_sources_on_one_road_are_combined(world):
    network, _, _, provider, _, _ = world
    provider.sources.live_traffic.readings.clear()
    view = provider.view()
    view.live.traffic[FREEWAY] = [reading(FREEWAY, 0.8, source="camera"), reading(FREEWAY, 0.4, source="transtar_rss")]
    sc = view.segment(seg(network, FREEWAY), NOW)
    assert sc.congestion_source == "live:camera+transtar_rss"
    assert sc.live_weight == pytest.approx(0.8)


# --- incidents -----------------------------------------------------------------------------


def test_incidents_slow_roads_and_closures_remove_them(world):
    network, _, sources, provider, _, _ = world
    base = provider.view().segment(seg(network, FREEWAY), NOW).travel_s
    sources.incidents.inject(FREEWAY, "crash", "Crash on Gulf Fwy", NOW - timedelta(minutes=5), 30)
    crash = provider.view().segment(seg(network, FREEWAY), NOW)
    assert crash.incident_slowdown == pytest.approx(1.6)
    assert crash.travel_s == pytest.approx(base * 1.6)

    sources.incidents.clear()
    sources.incidents.inject(FREEWAY, "crash", "Big crash", NOW, 30, lanes_blocked=3)
    assert provider.view().segment(seg(network, FREEWAY), NOW).incident_slowdown == pytest.approx(2.1)

    sources.incidents.clear()
    sources.incidents.inject(FREEWAY, "closure", "Gulf Fwy closed", NOW, 60)
    assert provider.view().segment(seg(network, FREEWAY), NOW).closed

    # Past its clear time the incident no longer matters.
    view = provider.view()
    assert not view.segment(seg(network, FREEWAY), NOW + timedelta(minutes=61)).closed


def test_incident_without_clear_time_uses_default_duration(world):
    network, _, sources, provider, _, _ = world
    sources.incidents.inject(FREEWAY, "stall", "Stall", NOW - timedelta(minutes=10), None)
    view = provider.view()
    assert view.segment(seg(network, FREEWAY), NOW + timedelta(minutes=30)).incident is not None
    assert view.segment(seg(network, FREEWAY), NOW + timedelta(minutes=40)).incident is None


def test_router_goes_around_a_closure_and_says_why(world):
    _, _, sources, _, router, _ = world
    before, _ = router.route("eastend", "downtown", NOW)
    assert FREEWAY in before.segment_ids  # Telephone Rd -> Gulf Fwy at noon
    sources.incidents.inject(FREEWAY, "closure", "Gulf Fwy closed at Telephone", NOW, 60)
    after, _ = router.route("eastend", "downtown", NOW)
    assert FREEWAY not in after.segment_ids
    assert any(r.startswith("Rerouted around I-45 Gulf Fwy: closed") and "demo feed" in r for r in after.reasons)


def test_router_goes_around_live_heavy_traffic_with_provenance(world):
    _, _, sources, _, router, _ = world
    sources.live_traffic.inject(reading(FREEWAY, 0.95, minutes_ago=2))
    route, _ = router.route("eastend", "downtown", NOW)
    assert FREEWAY not in route.segment_ids
    assert any("heavier traffic than usual right now (traffic camera, 2 min ago)" in r for r in route.reasons)


# --- crossings ------------------------------------------------------------------------------


def crossing(network, cid="x_navigation"):
    return network.crossings[cid]


def test_live_blocked_crossing_waits_until_clear(world):
    network, _, sources, provider, _, _ = world
    sources.trains.inject("x_navigation", NOW - timedelta(minutes=5), 20)  # clears 12:15
    view = provider.view()
    cc = view.crossing(crossing(network), NOW + timedelta(minutes=5))
    assert cc.live and cc.block_probability == 1.0 and cc.confidence == "high"
    assert cc.expected_delay_s == pytest.approx(10 * 60)
    after = view.crossing(crossing(network), NOW + timedelta(minutes=16))
    assert not after.live and after.source == "history"


def test_sensor_down_still_counts_but_is_low_confidence(world):
    network, _, sources, provider, _, _ = world
    sources.trains.set_sensor("x_navigation", up=False)
    view = provider.view()
    cc = view.crossing(crossing(network), NOW + timedelta(minutes=2))
    assert not cc.live and cc.confidence == "low" and cc.sensor_up is False

    sources.trains.inject("x_navigation", NOW, 10)
    blocked = provider.view().crossing(crossing(network), NOW + timedelta(minutes=2))
    assert blocked.live and blocked.block_probability == 1.0 and blocked.confidence == "low"


def test_clear_with_working_sensor_trusted_for_5_min_only(world):
    network, _, _, provider, _, _ = world
    from app.conditions.live import CrossingStatus

    view = provider.view()
    view.live.crossings["x_cullen"] = CrossingStatus("x_cullen", False, True, NOW, "trainwatch")
    soon = view.crossing(crossing(network, "x_cullen"), NOW + timedelta(minutes=4))
    later = view.crossing(crossing(network, "x_cullen"), NOW + timedelta(minutes=6))
    assert soon.live and soon.block_probability == 0 and soon.confidence == "high"
    assert not later.live and later.source == "history"


def test_stale_crossing_status_is_ignored(world):
    network, _, _, provider, _, _ = world
    from app.conditions.live import CrossingStatus

    view = provider.view()
    old = NOW - timedelta(minutes=20)
    view.live.crossings["x_cullen"] = CrossingStatus("x_cullen", True, True, old, "trainwatch", clears_at=NOW + timedelta(minutes=30))
    cc = view.crossing(crossing(network, "x_cullen"), NOW + timedelta(minutes=1))
    assert not cc.live and cc.confidence == "low"


# --- feeds down --------------------------------------------------------------------------------


def test_feed_down_falls_back_to_predictions_and_says_so(world):
    network, _, sources, provider, router, _ = world
    sources.live_traffic.inject(reading(FREEWAY, 0.95))
    sources.live_traffic.down = True
    sources.trains.down = True
    view = provider.view()
    assert set(view.feeds_down) == {"traffic", "trains"}
    sc = view.segment(seg(network, FREEWAY), NOW)
    assert sc.live_weight == 0 and sc.confidence == "low"
    far = view.segment(seg(network, FREEWAY), NOW + timedelta(minutes=45))
    assert far.confidence == "medium"
    route, _ = router.route("eastend", "medcenter", NOW)
    assert route.confidence == "low"
    assert any("Live traffic data is unavailable" in r for r in route.reasons)
    assert any("Live train data is unavailable" in r for r in route.reasons)


# --- route confidence + recommendation margin ---------------------------------------------------


def test_route_confidence_levels_and_safe_departure_margin(world):
    _, _, sources, _, router, clock = world
    plain = recommend_departure(router, "downtown", "galleria", MON(13, 0), earliest=NOW)
    assert plain.route.confidence == "medium"
    assert plain.depart_at - plain.leave_at_safe == timedelta(minutes=5)

    clock["now"] = plain.depart_at
    for sid in router.network.segments:  # fresh live readings everywhere, stamped "now"
        sources.live_traffic.inject(reading(sid, 0.2, at=plain.depart_at))
    live = recommend_departure(router, "downtown", "galleria", MON(13, 0), earliest=plain.depart_at)
    assert live.route.confidence == "high" and live.leave_at_safe == live.depart_at


# --- safety slider --------------------------------------------------------------------------


def test_safety_weight_resolution_and_monotone_exposure(world):
    _, _, _, _, router, _ = world
    assert resolve_safety(True, None) == 1.0 and resolve_safety(False, None) == 0.0
    assert resolve_safety(True, 0.3) == 0.3 and resolve_safety(None, 7) == 1.0
    assert crash_lambda(0) == 30 and crash_lambda(1) == 600
    exposures = [
        router.best_route("hobby", "galleria", MON(12), safety_weight=w).crash_exposure for w in (0, 0.25, 0.5, 0.75, 1)
    ]
    assert all(a >= b - 1e-9 for a, b in zip(exposures, exposures[1:]))
    assert exposures[0] > exposures[-1]
    old_style, _ = router.route("hobby", "galleria", MON(12), safe_path=True)
    new_style, _ = router.route("hobby", "galleria", MON(12), safety_weight=1.0)
    assert old_style.segment_ids == new_style.segment_ids
