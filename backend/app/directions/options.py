"""Up to three meaningfully different routes, each with a short label, its main road and what
slows it down.

The router already finds the best route and one alternative (the best route's roads made 1.5x
dearer). For more, the roads of every route found so far are made dearer, harder each round.
A candidate is kept only if it is really different (shares at most 75% of its length with any
route we have) and not much slower (at most 40% or 7 min slower than the best, whichever is more).
"""

import hashlib
from collections import defaultdict
from datetime import datetime

from app.causes import INCIDENT_CAUSE, RUSH_WINDOWS
from app.conditions.provider import ConditionsView
from app.graph import Network
from app.routing.router import (
    ALT_PENALTY,
    LIVE_REASON_EXTRA,
    NoRouteError,
    Route,
    Router,
    _dedupe_live,
    crash_lambda,
)

MAX_ROUTES = 3
MAX_SHARED = 0.75
SLOWER_FACTOR = 1.4
SLOWER_S = 7 * 60
PENALTIES = (ALT_PENALTY, 2.5, 4.0)
MIN_CAUSE_S = 60  # a delay smaller than this isn't worth naming
MAX_CAUSES = 3


def route_id(route: Route) -> str:
    """Stable id of a route: its segment path."""
    return hashlib.sha1("|".join(route.segment_ids).encode()).hexdigest()[:10]


def _miles(network: Network, ids: list[str]) -> float:
    return sum(network.segments[i].length_miles for i in ids)


def shared(network: Network, a: Route, b: Route) -> float:
    """Share of a's length that is also on b."""
    on_b = set(b.segment_ids)
    total = _miles(network, a.segment_ids)
    return _miles(network, [i for i in a.segment_ids if i in on_b]) / total if total else 1.0


def route_options(
    router: Router, best: Route, alt: Route | None, view: ConditionsView, naive: Route | None = None
) -> list[Route]:
    """[best, up to two alternatives]. `alt` is the router's own alternative (kept when it's
    different enough); `naive` (the traffic-only route) explains the extra ones."""
    net = router.network
    kept, seen = [best], [best]

    def consider(r: Route) -> bool:
        if any(r.segment_ids == s.segment_ids for s in seen):
            return False
        seen.append(r)
        if r.total_s > max(best.total_s * SLOWER_FACTOR, best.total_s + SLOWER_S):
            return False
        if any(shared(net, r, k) > MAX_SHARED or shared(net, k, r) > MAX_SHARED for k in kept):
            return False
        kept.append(r)
        return True

    if alt is not None:
        consider(alt)
    lam = crash_lambda(best.safety_weight)
    for factor in PENALTIES:
        if len(kept) >= MAX_ROUTES:
            break
        dearer = {sid: factor for r in seen for sid in r.segment_ids}
        try:
            ids = router._search(best.origin, best.destination, best.depart_at, lam, view, penalties=dearer)
        except NoRouteError:
            break
        if any(ids == s.segment_ids for s in seen):
            continue
        cand = router.evaluate(ids, best.origin, best.destination, best.depart_at, best.safety_weight, view)
        if consider(cand) and naive is not None:
            cand.reasons = _dedupe_live(router._reasons(cand, naive, view))
    return kept


# --- labels ---------------------------------------------------------------------------------


def route_labels(network: Network, routes: list[Route]) -> list[tuple[str, str]]:
    """(label, main road) per route. The label names the road that sets the route apart from the
    others ("via I-610", or "via I-610 South Loop" when another route is "via I-610" too); the
    main road is the one it spends the most miles on."""
    miles: list[dict[str, float]] = []
    for r in routes:
        m: dict[str, float] = defaultdict(float)
        for sid in r.segment_ids:
            m[network.segments[sid].name] += network.segments[sid].length_miles
        miles.append(m)
    code = {s.name: (s.highway if s.road_class == "freeway" else s.name) for s in network.segments.values()}

    picks: list[str] = []
    for i, m in enumerate(miles):
        others = [miles[j] for j in range(len(routes)) if j != i]

        def unique(name: str) -> float:
            return m[name] - max((o.get(name, 0.0) for o in others), default=0.0)

        ranked = sorted(m, key=lambda n: (-unique(n), -m[n])) if others else sorted(m, key=lambda n: -m[n])
        fresh = [n for n in ranked if n not in picks and (not others or unique(n) > 0.3)]
        picks.append(fresh[0] if fresh else next((n for n in ranked if n not in picks), ranked[0] if ranked else ""))
    out = []
    for i, (pick, m) in enumerate(zip(picks, miles)):
        if not m:  # both ends at the same spot on our map: no main road at all
            out.append(("via local streets", "Local streets"))
            continue
        short = code.get(pick, pick)
        clash = any(code.get(p, p) == short for j, p in enumerate(picks) if j != i)
        out.append((f"via {pick if clash else short}", max(m, key=m.get)))
    return out


# --- what slows it down ---------------------------------------------------------------------


def _rush(t: datetime) -> bool:
    minute = t.hour * 60 + t.minute
    return t.weekday() < 5 and any(a <= minute < b for a, b, _ in RUSH_WINDOWS)


def _crossing_place(name: str) -> str:
    """ "Cullen Blvd @ UP" -> "Cullen Blvd"."""
    return name.split(" @ ")[0]


def delay_causes(network: Network, route: Route) -> list[dict]:
    """The biggest delays on a route vs. empty roads, worst first (at most 3):
    {"kind": rush|volume|crash|construction|closure|event|weather|train, "label", "road", "minutes"}.
    `kind` matches the app's cause icons."""
    found: dict[tuple[str, str], dict] = {}

    def add(kind: str, label: str, road: str, seconds: float) -> None:
        item = found.setdefault((kind, road), {"kind": kind, "label": label, "road": road, "seconds": 0.0})
        item["seconds"] += seconds

    for s in route.segments:
        info = network.segments[s.id]
        extra = s.travel_s * (1 - 1 / s.incident_slowdown) if s.incident and s.incident_slowdown > 1 else 0.0
        traffic = max(0.0, s.travel_s - extra - info.free_flow_seconds)
        if s.live_weight >= 0.3 and s.congestion - s.predicted_congestion >= LIVE_REASON_EXTRA:
            add("volume", f"Heavier than usual on {s.name}", s.name, traffic)
        elif _rush(s.enter_at):
            add("rush", f"Rush hour on {s.name}", s.name, traffic)
        else:
            add("rush", f"Traffic on {s.name}", s.name, traffic)
        if extra and s.incident:
            kind, what = INCIDENT_CAUSE.get(s.incident.kind, ("crash", "Incident"))
            add(kind, f"{what} on {s.name}", s.name, extra)
        if s.closure_wait_s and s.closure:
            add("closure", f"{s.name} closed", s.name, s.closure_wait_s)
        for c in s.crossings:
            if c.expected_delay_s:
                where = _crossing_place(c.name)
                what = "Train blocking" if c.live and c.block_probability >= 1.0 else "Train at"
                add("train", f"{what} {where}", where, c.expected_delay_s)

    items = sorted((v for v in found.values() if v["seconds"] >= MIN_CAUSE_S), key=lambda v: -v["seconds"])
    return [
        {"kind": v["kind"], "label": v["label"], "road": v["road"], "minutes": max(1, round(v["seconds"] / 60))}
        for v in items[:MAX_CAUSES]
    ]
