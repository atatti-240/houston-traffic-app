"""Multi-stop planner: stop order, departure times, windows, live conditions, baseline."""

from datetime import datetime, timedelta

import pytest

from app.adapters import build_sources
from app.conditions.provider import ConditionsProvider
from app.planner import Place, StopRequest, _Planner, plan_trip, stop_orders
from app.routing.router import Router

MON = lambda h, m=0: datetime(2026, 9, 28, h, m)  # noqa: E731
NOW = MON(12, 0)


@pytest.fixture
def world(trained):
    network, models, _, factory = trained
    sources = build_sources("mock", factory, 42)
    clock = {"now": NOW}
    router = Router(network, models, ConditionsProvider(network, models, sources, lambda: clock["now"]))
    return network, sources, router, clock


def place(network, node, snapped_km=0.0):
    n = network.nodes[node]
    return Place(n.name, n.id, n.lat, n.lng, snapped_km)


def stop(network, node, start=None, end=None, dwell=0, fixed=False):
    return StopRequest(place(network, node), start, end, dwell, fixed)


def test_stop_orders_respect_fixed_positions(world):
    network, *_ = world
    a, b, c = (stop(network, n) for n in ("galleria", "medcenter", "hobby"))
    assert len(stop_orders([a, b, c])) == 6
    fixed_a = stop(network, "galleria", fixed=True)
    orders = stop_orders([fixed_a, b, c])
    assert len(orders) == 2 and all(o[0] is fixed_a for o in orders)
    assert len(stop_orders([stop(network, n, fixed=True) for n in ("galleria", "medcenter", "hobby")])) == 1


def test_bad_stop_counts(world):
    network, _, router, _ = world
    with pytest.raises(ValueError):
        plan_trip(router, place(network, "downtown"), [], NOW, NOW)
    four = [stop(network, n) for n in ("galleria", "medcenter", "hobby", "eastend")]
    with pytest.raises(ValueError):
        plan_trip(router, place(network, "downtown"), four, NOW, NOW)


def test_picks_the_cheapest_order_and_never_leaves_before_now(world):
    network, _, router, _ = world
    stops = [stop(network, n) for n in ("hobby", "galleria", "medcenter")]
    plan = plan_trip(router, place(network, "downtown"), stops, NOW - timedelta(hours=1), NOW)
    view = router.view(NOW)
    p = _Planner(router, view, 0.0, timedelta(minutes=5))
    best_now = min(p.simulate(place(network, "downtown"), o, NOW, NOW).cost for o in stop_orders(stops))
    assert plan.cost_min <= best_now + 1e-6
    assert plan.legs[0].leave_at >= NOW
    assert [leg.to.node for leg in plan.legs] == [s.place.node for s in plan.order]
    for prev, nxt in zip(plan.legs, plan.legs[1:]):  # each leg starts where the last one ended
        assert nxt.frm == prev.to and nxt.leave_at >= prev.arrive_at


def test_fixed_first_stop_stays_first(world):
    network, _, router, _ = world
    stops = [stop(network, "hobby", fixed=True), stop(network, "galleria"), stop(network, "midtown")]
    plan = plan_trip(router, place(network, "downtown"), stops, NOW, NOW)
    assert plan.order[0].place.node == "hobby"


def test_windows_decide_the_order_and_the_departure(world):
    network, _, router, _ = world
    # Typed the wrong way round: the Galleria meeting is first.
    stops = [
        stop(network, "medcenter", MON(15, 0), MON(15, 30)),
        stop(network, "galleria", MON(13, 30), MON(14, 0), dwell=45),
    ]
    plan = plan_trip(router, place(network, "downtown"), stops, NOW, NOW)
    assert plan.order_names == ["Galleria / Uptown", "Texas Medical Center"]
    assert plan.status == "ok" and not plan.warnings
    first, second = plan.legs
    # Leave as late as still makes the window start, not right now.
    assert first.leave_at > NOW + timedelta(minutes=45)
    assert MON(13, 15) <= first.arrive_at <= MON(13, 30)
    assert first.wait_min < 10
    assert second.ready_at == max(first.arrive_at, MON(13, 30)) + timedelta(minutes=45)
    assert second.leave_at >= second.ready_at and second.arrive_at <= MON(15, 30)
    for leg in plan.legs:
        assert leg.ready_at <= leg.leave_at_safe <= leg.leave_at
    # The baseline (typed order, leave now) misses the Galleria window.
    assert plan.baseline.late_stops >= 1


def test_impossible_window_comes_back_late_with_a_warning(world):
    network, _, router, _ = world
    plan = plan_trip(router, place(network, "downtown"), [stop(network, "hobby", end=NOW + timedelta(minutes=3))], NOW, NOW)
    assert plan.status == "late"
    assert plan.late_stops[0].late_min > 0
    assert plan.legs[0].leave_at == NOW  # best you can do is go now
    assert any(w.startswith("Can't reach Hobby Airport") for w in plan.warnings)


def test_far_snapped_place_is_flagged(world):
    network, _, router, _ = world
    far = StopRequest(place(network, "galleria", snapped_km=4.2))
    plan = plan_trip(router, place(network, "downtown"), [far], NOW, NOW)
    assert any("4.2 km from the nearest point" in w for w in plan.warnings)


def test_closure_changes_the_stop_order(world):
    network, sources, router, _ = world
    stops = [stop(network, "galleria"), stop(network, "medcenter")]
    before = plan_trip(router, place(network, "downtown"), stops, NOW, NOW)
    assert before.order_names == ["Texas Medical Center", "Galleria / Uptown"]
    sources.incidents.inject("I69:downtown>midtown", "closure", "I-69 closed at Midtown", NOW, 60)
    after = plan_trip(router, place(network, "downtown"), stops, NOW, NOW)
    assert after.order_names == ["Galleria / Uptown", "Texas Medical Center"]
    assert all("I69:downtown>midtown" not in leg.route.segment_ids for leg in after.legs)


def test_live_blocked_crossing_is_avoided_by_the_plan(world):
    network, sources, router, clock = world
    stops = [stop(network, "downtown")]
    before = plan_trip(router, place(network, "eastend"), stops, NOW, NOW, safety_weight=1.0)
    assert "x_navigation" in {c.id for c in before.legs[0].route.crossings}
    sources.trains.inject("x_navigation", NOW, 30)
    after = plan_trip(router, place(network, "eastend"), stops, NOW, NOW, safety_weight=1.0)
    assert "x_navigation" not in {c.id for c in after.legs[0].route.crossings}
    assert any(r.startswith("Rerouted around Navigation") for r in after.legs[0].route.reasons)


def test_feed_down_is_reported_in_plan(world):
    network, sources, router, _ = world
    sources.trains.down = True
    plan = plan_trip(router, place(network, "eastend"), [stop(network, "medcenter")], NOW, NOW)
    assert plan.feeds_down == ["trains"]
    assert plan.freshness["feeds"]["trains"] == "down"
    assert "Train feed is down; using predictions" in plan.warnings
    assert plan.legs[0].confidence == "low"
    assert plan.legs[0].leave_at_safe == plan.legs[0].ready_at  # can't leave before now
