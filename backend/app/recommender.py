"""Departure-time recommender: the latest departure that still gets you there on time."""

from dataclasses import dataclass
from datetime import datetime, timedelta

from app.routing.router import Route, Router

STEP_MIN = 5
WINDOW_MIN = 120


@dataclass
class Recommendation:
    depart_at: datetime
    arrive_by: datetime
    route: Route
    alternative: Route | None
    on_time: bool
    confidence: float
    buffer_min: int

    @property
    def eta(self) -> datetime:
        return self.route.arrive_at

    @property
    def lead_minutes(self) -> float:
        return (self.arrive_by - self.depart_at).total_seconds() / 60

    @property
    def confidence_label(self) -> str:
        return "high" if self.confidence >= 0.8 else "medium" if self.confidence >= 0.6 else "low"


def route_confidence(route: Route) -> float:
    """Lower when the route leans on a crossing that might be blocked or a crash-prone road."""
    predicted_trains = max((c.block_probability for c in route.crossings if not c.live), default=0.0)
    return round(min(0.99, max(0.3, 1.0 - 0.5 * predicted_trains - 0.3 * route.max_crash_risk)), 2)


def recommend_departure(
    router: Router,
    origin: str,
    destination: str,
    arrive_by: datetime,
    safe_path: bool = False,
    buffer_min: int = 5,
    earliest: datetime | None = None,
) -> Recommendation:
    """Try departures every STEP_MIN minutes, latest first, back to WINDOW_MIN before arrive_by
    (or `earliest`, e.g. now). Pick the latest one whose ETA + buffer <= arrive_by."""
    start = arrive_by - timedelta(minutes=WINDOW_MIN)
    if earliest is not None:
        start = max(start, earliest)
    buffer = timedelta(minutes=buffer_min)

    t = arrive_by
    chosen, on_time = None, False
    while t >= start:
        r = router.best_route(origin, destination, t, safe_path)
        if r.arrive_at + buffer <= arrive_by:
            chosen, on_time = t, True
            break
        t -= timedelta(minutes=STEP_MIN)
    if chosen is None:
        chosen = start  # can't make it: leave as early as allowed

    best, alt = router.route(origin, destination, chosen, safe_path)
    return Recommendation(
        depart_at=chosen,
        arrive_by=arrive_by,
        route=best,
        alternative=alt,
        on_time=on_time,
        confidence=route_confidence(best),
        buffer_min=buffer_min,
    )


def route_summary(route: Route) -> str:
    names: list[str] = []
    for s in route.segments:
        if not names or names[-1] != s.name:
            names.append(s.name)
    return " → ".join(names)
