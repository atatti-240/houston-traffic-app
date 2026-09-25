from collections import defaultdict
from datetime import date

from sqlalchemy import select

from app.models import Camera, Node, RailCrossing, RoadSegment
from app.seed.synthetic import SyntheticWorld


def _adjacency(session):
    adj = defaultdict(list)
    for seg in session.scalars(select(RoadSegment)):
        adj[seg.from_node].append(seg.to_node)
    return adj


def _reachable(adj, start):
    seen, stack = {start}, [start]
    while stack:
        for nxt in adj[stack.pop()]:
            if nxt not in seen:
                seen.add(nxt)
                stack.append(nxt)
    return seen


def _simple_paths(adj, src, dst, max_len=8):
    paths, stack = [], [(src, [src])]
    while stack:
        node, path = stack.pop()
        if node == dst:
            paths.append(path)
            continue
        if len(path) > max_len:
            continue
        for nxt in adj[node]:
            if nxt not in path:
                stack.append((nxt, path + [nxt]))
    return paths


def test_graph_is_strongly_connected(session):
    adj = _adjacency(session)
    nodes = {n.id for n in session.scalars(select(Node))}
    for n in nodes:
        assert _reachable(adj, n) == nodes, f"not everything reachable from {n}"


def test_multiple_routes_downtown_to_galleria(session):
    paths = _simple_paths(_adjacency(session), "downtown", "galleria")
    assert len(paths) >= 2


def test_crossings_and_cameras_seeded(session):
    crossings = session.scalars(select(RailCrossing)).all()
    assert len(crossings) >= 10
    seg_ids = {s.id for s in session.scalars(select(RoadSegment))}
    for c in crossings:
        assert c.segment_id in seg_ids and c.reverse_segment_id in seg_ids
    kinds = {c.kind for c in session.scalars(select(Camera))}
    assert kinds == {"highway", "train"}


def test_synthetic_world_is_deterministic():
    day = date(2026, 9, 21)
    a, b = SyntheticWorld(7), SyntheticWorld(7)
    assert a.speed_observations(day)[:50] == b.speed_observations(day)[:50]
    assert a.train_events(day) == b.train_events(day)
    assert a.crashes(day) == b.crashes(day)


def test_synthetic_rush_hour_slower_than_night():
    world = SyntheticWorld(42)
    obs = {(o.segment_id, o.slot): o.speed_mph for o in world.speed_observations(date(2026, 9, 21))}
    seg = "I45N:i45_610n>downtown"  # inbound North Fwy on a Monday
    assert obs[(seg, 31)] < obs[(seg, 12)] * 0.7  # 07:45 vs 03:00


def test_recurring_train_shows_up_most_weekdays():
    world = SyntheticWorld(42)
    hits = 0
    for d in range(1, 21):
        day = date(2026, 9, d)
        if day.weekday() >= 5:
            continue
        events = [e for e in world.train_events(day) if e.crossing_id == "x_cullen"]
        if any(e.start.hour == 7 and 20 <= e.start.minute <= 50 for e in events):
            hits += 1
    assert hits >= 9  # ~85% of 14 weekdays
