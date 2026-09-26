"""Departure-time recommender: the latest departure that still gets you there on time."""

from dataclasses import dataclass
from datetime import datetime, timedelta

from app.conditions.live import CONFIDENCE_RANK, Confidence
from app.conditions.provider import ConditionsView
from app.routing.router import Route, Router, resolve_safety

STEP_MIN = 5
WINDOW_MIN = 120
# How much earlier "leave_at_safe" is than "leave_at", by how sure we are about the route.
SAFE_MARGIN_MIN: dict[str, int] = {"high": 0, "medium": 5, "low": 10}


@dataclass
class Recommendation:
    depart_at: datetime
    arrive_by: datetime
    route: Route
    alternative: Route | None
    on_time: bool
    confidence: float
    buffer_min: int
    earliest: datetime | None = None

    @property
    def eta(self) -> datetime:
        return self.route.arrive_at

    @property
    def lead_minutes(self) -> float:
        return (self.arrive_by - self.depart_at).total_seconds() / 60

    @property
    def data_confidence(self) -> Confidence:
        return self.route.confidence

    @property
    def confidence_label(self) -> Confidence:
        """The worse of the route-risk score and how good the underlying data is."""
        score: Confidence = "high" if self.confidence >= 0.8 else "medium" if self.confidence >= 0.6 else "low"
        return score if CONFIDENCE_RANK[score] <= CONFIDENCE_RANK[self.data_confidence] else self.data_confidence

    @property
    def leave_at_safe(self) -> datetime:
        """Leave this much earlier if you can't afford to be late: more margin when the
        route rests on predictions or low-confidence data. Never before `earliest`."""
        t = self.depart_at - timedelta(minutes=SAFE_MARGIN_MIN[self.confidence_label])
        return max(t, self.earliest) if self.earliest else t


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
    safety_weight: float | None = None,
    view: ConditionsView | None = None,
) -> Recommendation:
    """Try departures every STEP_MIN minutes, latest first, back to WINDOW_MIN before arrive_by
    (or `earliest`, e.g. now). Pick the latest one whose ETA + buffer <= arrive_by.

    `earliest` itself is always tried last, so "leave right now" is considered even when it
    falls between two grid times. If nothing fits, the answer is to leave as early as allowed
    and `on_time` is False. All candidates are judged against one snapshot of live data."""
    w = resolve_safety(safe_path, safety_weight)
    if view is None and router.conditions.has_clock:
        view = router.view()
    start = arrive_by - timedelta(minutes=WINDOW_MIN)
    if earliest is not None:
        start = max(start, earliest)
    buffer = timedelta(minutes=buffer_min)

    candidates = []
    t = arrive_by
    while t >= start:
        candidates.append(t)
        t -= timedelta(minutes=STEP_MIN)
    if not candidates or candidates[-1] != start:
        candidates.append(start)

    chosen = None
    for t in candidates:
        r = router.best_route(origin, destination, t, safety_weight=w, view=view)
        if r.arrive_at + buffer <= arrive_by:
            chosen = t
            break
    if chosen is None:
        # Can't make it: leave as early as allowed, unless that only means sitting at a
        # closed road, in which case leave later and arrive just as soon.
        chosen = latest_same_arrival(router, origin, destination, start, w, view)

    best, alt = router.route(origin, destination, chosen, safety_weight=w, view=view)
    return Recommendation(
        depart_at=chosen,
        arrive_by=arrive_by,
        route=best,
        alternative=alt,
        on_time=best.arrive_at + buffer <= arrive_by,
        confidence=route_confidence(best),
        buffer_min=buffer_min,
        earliest=earliest,
    )


def latest_same_arrival(
    router: Router,
    origin: str,
    destination: str,
    depart_at: datetime,
    safety_weight: float,
    view: ConditionsView | None,
    step: timedelta = timedelta(minutes=STEP_MIN),
    slack: timedelta = timedelta(minutes=1),
) -> datetime:
    """If leaving at depart_at means waiting at a closed road, the latest departure (in
    `step`s) that still arrives within `slack` of that arrival; otherwise depart_at."""
    r0 = router.best_route(origin, destination, depart_at, safety_weight=safety_weight, view=view)
    best = depart_at
    for k in range(1, int(r0.closure_wait_s // step.total_seconds()) + 1):
        t = depart_at + step * k
        if router.best_route(origin, destination, t, safety_weight=safety_weight, view=view).arrive_at <= r0.arrive_at + slack:
            best = t
    return best


def route_summary(route: Route) -> str:
    names: list[str] = []
    for s in route.segments:
        if not names or names[-1] != s.name:
            names.append(s.name)
    return " → ".join(names)
