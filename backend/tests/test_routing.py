from datetime import datetime

import pytest

from app.routing.router import NoRouteError, Router
from app.conditions.provider import ConditionsProvider

MON = lambda h, m=0: datetime(2026, 9, 28, h, m)  # noqa: E731


@pytest.fixture(scope="module")
def router(trained):
    network, models, _, _ = trained
    return Router(network, models)


def test_route_is_connected_and_times_add_up(router, trained):
    network = trained[0]
    best, _ = router.route("downtown", "galleria", MON(7, 35))
    assert network.segments[best.segment_ids[0]].from_node == "downtown"
    assert network.segments[best.segment_ids[-1]].to_node == "galleria"
    for a, b in zip(best.segment_ids, best.segment_ids[1:]):
        assert network.segments[a].to_node == network.segments[b].from_node
    assert best.total_s == pytest.approx(best.base_travel_s + best.train_delay_s)
    assert best.total_s >= best.free_flow_s
    assert best.geometry[0] == [network.nodes["downtown"].lat, network.nodes["downtown"].lng]


def test_rush_hour_trip_takes_longer_than_midday(router):
    rush, _ = router.route("downtown", "galleria", MON(7, 35))
    noon, _ = router.route("downtown", "galleria", MON(12))
    assert rush.total_s > noon.total_s


def test_avoids_crossing_during_blockage_window_but_uses_it_at_noon(router):
    rush, _ = router.route("eastend", "medcenter", MON(7, 35))
    noon, _ = router.route("eastend", "medcenter", MON(12))
    assert "x_cullen" not in {c.id for c in rush.crossings}
    assert "x_cullen" in {c.id for c in noon.crossings}
    assert any("Cullen" in r and "train" in r for r in rush.reasons)


def test_safe_path_changes_route_and_lowers_crash_exposure(router):
    changed = []
    for o, d, t in [("eastend", "downtown", MON(12)), ("heights", "downtown", MON(12)), ("hobby", "galleria", MON(12))]:
        normal, _ = router.route(o, d, t)
        safe, _ = router.route(o, d, t, safe_path=True)
        assert safe.crash_exposure <= normal.crash_exposure + 1e-9
        if safe.segment_ids != normal.segment_ids:
            changed.append((o, d))
    assert changed, "safe_path never changed a route"


def test_alternative_route_differs(router):
    best, alt = router.route("downtown", "galleria", MON(7, 35))
    assert alt is not None and alt.segment_ids != best.segment_ids


def test_live_blockage_reroutes(trained):
    network, models, sources, _ = trained
    sources.clear_demo_live()
    sources.trains.inject("x_navigation", MON(12), 30)
    now = lambda: MON(12, 5)  # noqa: E731
    free = Router(network, models)
    blocked = Router(network, models, ConditionsProvider(network, models, sources, now))
    try:
        before, _ = free.route("eastend", "downtown", MON(12, 5), safe_path=True)
        after, _ = blocked.route("eastend", "downtown", MON(12, 5), safe_path=True)
    finally:
        sources.clear_demo_live()
    assert "x_navigation" in {c.id for c in before.crossings}
    assert "x_navigation" not in {c.id for c in after.crossings}
    assert any(r.startswith("Rerouted around Navigation") for r in after.reasons)


def test_unknown_node_raises(router):
    with pytest.raises(NoRouteError):
        router.route("downtown", "atlantis", MON(8))


def test_safe_path_explains_itself_without_repeating_roads(router):
    safe, _ = router.route("downtown", "hobby", MON(17, 10), safe_path=True)
    assert any(r.startswith("Safe Path:") and "less crash exposure" in r for r in safe.reasons)
    avoided = [r.split(":")[0] for r in safe.reasons if r.startswith("Avoided")]
    assert len(avoided) == len(set(avoided))
