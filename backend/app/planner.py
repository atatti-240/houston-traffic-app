"""Multi-stop planner (docs/specs section 5): best stop order and departure times.

Search
  - Every stop order (at most 3 stops -> 6 orders; stops marked fixed_order keep their place)
  - x first departures every 15 min for the next 2 h, plus every 15 min in the 2 h before
    each stop's target time (so a window later in the day gets a departure near it), then
    the best one refined to 5 min.
  - The first departure aims to arrive at the first stop's window start (or its end minus
    the buffer when only an end is given): time at home beats time waiting at a stop.
  - Later legs leave when you're ready (arrival + dwell), later only to avoid arriving
    before a stop's window opens (never so late that you'd arrive after it opened), or to
    avoid sitting at a closed road when leaving later arrives just as soon. Arriving early
    for an end-only window costs nothing, so waiting it out at the previous stop would only
    risk the stops after it.
  - Each leg is routed by the router on ONE snapshot of live conditions.

Cost (minutes, lower is better)
    sum(route cost: drive + closure wait + train delay + crash penalty) + 0.5 x wait
    (first stop: early arrival before its target; later stops: waiting for a window to open,
    or idling at the previous stop before leaving for it)
    + 0.3 x minutes the first departure is later than the earliest possible one

Ranking: fewest stops missed (arrive after window end), then fewest "tight" stops (inside
the buffer), then least lateness, then cost. If every order is late, the plan with the
fewest late stops is returned with status "late".
"""

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from itertools import permutations

from app.conditions.live import CONFIDENCE_RANK, Confidence
from app.conditions.provider import ConditionsView
from app.recommender import SAFE_MARGIN_MIN, latest_departure_for, route_confidence
from app.routing.router import Route, Router, resolve_safety

MAX_STOPS = 3
FIRST_STEP = timedelta(minutes=15)
FIRST_HORIZON = timedelta(hours=2)
REFINE_STEP = timedelta(minutes=5)
REFINE_SPAN = timedelta(minutes=15)
LEG_STEP = timedelta(minutes=5)
WAIT_WEIGHT = 0.5
DELAY_WEIGHT = 0.3
FAR_SNAP_KM = 1.0
CLOSURE_SLACK = timedelta(minutes=1)
ORDER_SWITCH_MIN = 3.0  # a watched plan changes stop order only for at least this much gain


@dataclass(frozen=True)
class Place:
    name: str
    node: str
    lat: float
    lng: float
    snapped_km: float = 0.0  # distance from the requested point to the graph node used


@dataclass(frozen=True)
class StopRequest:
    place: Place
    window_start: datetime | None = None
    window_end: datetime | None = None
    dwell_min: float = 0.0
    fixed_order: bool = False

    def target(self, buffer: timedelta) -> datetime | None:
        """When we'd ideally arrive: the window start, else end minus buffer, else ASAP."""
        if self.window_start is not None:
            return self.window_start
        if self.window_end is not None:
            return self.window_end - buffer
        return None


@dataclass
class LegPlan:
    frm: Place
    stop: StopRequest
    ready_at: datetime  # earliest you could leave (previous arrival + dwell, or earliest start)
    leave_at: datetime
    arrive_at: datetime
    wait_min: float  # waiting at the stop for its window to open
    late_min: float  # minutes after the window end (0 if on time)
    tight: bool  # on time but inside the buffer
    route: Route
    alternative: Route | None = None

    @property
    def to(self) -> Place:
        return self.stop.place

    @property
    def confidence(self) -> Confidence:
        score: Confidence = "high" if route_confidence(self.route) >= 0.8 else (
            "medium" if route_confidence(self.route) >= 0.6 else "low"
        )
        data = self.route.confidence
        return score if CONFIDENCE_RANK[score] <= CONFIDENCE_RANK[data] else data

    @property
    def leave_at_safe(self) -> datetime:
        return max(self.ready_at, self.leave_at - timedelta(minutes=SAFE_MARGIN_MIN[self.confidence]))

    @property
    def service_start(self) -> datetime:
        ws = self.stop.window_start
        return max(self.arrive_at, ws) if ws else self.arrive_at


@dataclass
class Plan:
    start: Place
    stops: list[StopRequest]  # as requested (typed order)
    order: list[StopRequest]  # chosen order
    legs: list[LegPlan]
    depart_after: datetime
    now: datetime
    safety_weight: float
    buffer_min: int
    cost_min: float
    baseline: "Baseline"
    warnings: list[str] = field(default_factory=list)
    feeds_down: list[str] = field(default_factory=list)
    freshness: dict = field(default_factory=dict)

    @property
    def late_stops(self) -> list[LegPlan]:
        return [leg for leg in self.legs if leg.late_min > 0]

    @property
    def status(self) -> str:
        return "late" if self.late_stops else "ok"

    @property
    def drive_min(self) -> float:
        return sum(leg.route.total_s for leg in self.legs) / 60

    @property
    def order_names(self) -> list[str]:
        return [s.place.name for s in self.order]


@dataclass
class _Sim:
    order: tuple[StopRequest, ...]
    first_departure: datetime
    legs: list[tuple[Place, StopRequest, datetime, datetime, Route]]  # frm, stop, ready, leave, route
    late: int
    tight: int
    late_min: float
    cost: float

    @property
    def key(self) -> tuple:
        return (self.late, self.tight, round(self.late_min), round(self.cost, 3), self.first_departure)


def stop_orders(stops: list[StopRequest]) -> list[tuple[StopRequest, ...]]:
    """All orders that keep fixed_order stops at their typed position."""
    n = len(stops)
    out = []
    for perm in permutations(range(n)):
        if all(perm[i] == i for i in range(n) if stops[i].fixed_order):
            out.append(tuple(stops[i] for i in perm))
    return out


class _Planner:
    def __init__(self, router: Router, view: ConditionsView, weight: float, buffer: timedelta) -> None:
        self.router = router
        self.view = view
        self.weight = weight
        self.buffer = buffer
        self._cache: dict[tuple[str, str, datetime], Route] = {}

    def best(self, frm: str, to: str, at: datetime) -> Route:
        key = (frm, to, at)
        if key not in self._cache:
            self._cache[key] = self.router.best_route(frm, to, at, safety_weight=self.weight, view=self.view)
        return self._cache[key]

    def leg_departure(self, frm: Place, stop: StopRequest, ready: datetime) -> datetime:
        """For a later leg: leave when ready, or later to arrive as the stop's window opens,
        or later still if leaving now would only mean sitting at a closed road."""
        return self.skip_closure_wait(frm, stop, self._window_departure(frm, stop, ready))

    def _window_departure(self, frm: Place, stop: StopRequest, ready: datetime) -> datetime:
        target = stop.window_start
        if target is None:
            return ready
        slack = target - self.best(frm.node, stop.place.node, ready).arrive_at
        if slack < LEG_STEP:
            return ready
        dep = ready + LEG_STEP * math.floor(slack / LEG_STEP)
        while dep > ready:
            r = self.best(frm.node, stop.place.node, dep)
            fits_end = stop.window_end is None or r.arrive_at + self.buffer <= stop.window_end
            if r.arrive_at <= target and fits_end:  # never later than leaving when ready
                return dep
            dep -= LEG_STEP
        return ready

    def skip_closure_wait(self, frm: Place, stop: StopRequest, dep: datetime) -> datetime:
        """If leaving at dep means waiting at a closed road, the latest departure (on 5-min
        marks) that still arrives within a minute of it."""
        r0 = self.best(frm.node, stop.place.node, dep)
        return latest_departure_for(lambda t: self.best(frm.node, stop.place.node, t), r0, dep, LEG_STEP, CLOSURE_SLACK)

    def simulate(self, start: Place, order: tuple[StopRequest, ...], d0: datetime, earliest: datetime) -> _Sim:
        loc, ready = start, d0
        legs, late, tight, late_min, cost = [], 0, 0, 0.0, 0.0
        for i, stop in enumerate(order):
            leave = d0 if i == 0 else self.leg_departure(loc, stop, ready)
            r = self.best(loc.node, stop.place.node, leave)
            arrive = r.arrive_at
            # First stop: arriving before its target is time better spent at home. Later
            # stops: only waiting for a window to open is wasted.
            target = stop.target(self.buffer) if i == 0 else stop.window_start
            wait = max(0.0, (target - arrive).total_seconds() / 60) if target else 0.0
            if stop.window_end is not None:
                over = (arrive - stop.window_end).total_seconds() / 60
                if over > 0:
                    late += 1
                    late_min += over
                elif arrive + self.buffer > stop.window_end:
                    tight += 1
            idle = (leave - ready).total_seconds() / 60 if i else 0.0  # sitting at the previous stop
            cost += r.cost / 60 + WAIT_WEIGHT * (wait + idle)
            legs.append((loc, stop, ready if i else earliest, leave, r))
            service = max(arrive, stop.window_start) if stop.window_start else arrive
            ready = service + timedelta(minutes=stop.dwell_min)
            loc = stop.place
        cost += DELAY_WEIGHT * max(0.0, (d0 - earliest).total_seconds() / 60)
        return _Sim(order, d0, legs, late, tight, late_min, cost)


def _first_departures(order: tuple[StopRequest, ...], earliest: datetime, buffer: timedelta) -> list[datetime]:
    """The earliest departure, every quarter hour on the clock for 2 h after it, and every
    15 min in the 2 h before each stop's target (so a window hours away still gets a
    departure close to it). Clock-anchored, so re-planning a minute later tries the same
    times and doesn't flip between near-equal plans."""
    n = int(FIRST_HORIZON / FIRST_STEP)
    first_mark = earliest.replace(minute=0, second=0, microsecond=0)
    while first_mark <= earliest:
        first_mark += FIRST_STEP
    times = {earliest} | {first_mark + FIRST_STEP * k for k in range(n) if first_mark + FIRST_STEP * k <= earliest + FIRST_HORIZON}
    for stop in order:
        target = stop.target(buffer)
        if target is not None and target > earliest + FIRST_HORIZON:
            times |= {target - FIRST_STEP * k for k in range(n + 1) if target - FIRST_STEP * k >= earliest}
    return sorted(times)


def plan_trip(
    router: Router,
    start: Place,
    stops: list[StopRequest],
    depart_after: datetime,
    now: datetime,
    safety_weight: float | None = None,
    safe_path: bool = False,
    buffer_min: int = 5,
    view: ConditionsView | None = None,
    prefer_order: list[str] | None = None,
) -> Plan:
    """prefer_order: stop names in the order currently planned (re-planning a watched plan).
    It is kept unless another order is better on lateness or saves ORDER_SWITCH_MIN of cost,
    so a re-plan doesn't flip between near-equal orders."""
    if not stops:
        raise ValueError("add at least one stop")
    if len(stops) > MAX_STOPS:
        raise ValueError(f"at most {MAX_STOPS} stops")
    w = resolve_safety(safe_path, safety_weight)
    view = view or router.view(now)
    buffer = timedelta(minutes=buffer_min)
    earliest = max(depart_after, now)
    p = _Planner(router, view, w, buffer)

    steps = int(REFINE_SPAN / REFINE_STEP)
    per_order = []
    for order in stop_orders(stops):
        best = min((p.simulate(start, order, d, earliest) for d in _first_departures(order, earliest, buffer)), key=lambda s: s.key)
        center = best.first_departure
        for k in range(-steps, steps + 1):
            d = center + REFINE_STEP * k
            if k and d >= earliest:
                best = min(best, p.simulate(start, order, d, earliest), key=lambda s: s.key)
        per_order.append(best)
    best = min(per_order, key=lambda s: s.key)
    if prefer_order:
        kept = next((s for s in per_order if [x.place.name for x in s.order] == list(prefer_order)), None)
        if kept is not None and kept.key[:3] == best.key[:3] and kept.cost - best.cost < ORDER_SWITCH_MIN:
            best = kept

    legs = []
    for frm, stop, ready, leave, _ in best.legs:
        route, alt = router.route(frm.node, stop.place.node, leave, safety_weight=w, view=view)
        late_min = 0.0
        tight = False
        if stop.window_end is not None:
            late_min = max(0.0, (route.arrive_at - stop.window_end).total_seconds() / 60)
            tight = late_min == 0 and route.arrive_at + buffer > stop.window_end
        legs.append(
            LegPlan(
                frm=frm,
                stop=stop,
                ready_at=ready,
                leave_at=leave,
                arrive_at=route.arrive_at,
                wait_min=(
                    max(0.0, (stop.window_start - route.arrive_at).total_seconds() / 60) if stop.window_start else 0.0
                ),
                late_min=late_min,
                tight=tight,
                route=route,
                alternative=alt,
            )
        )

    plan = Plan(
        start=start,
        stops=stops,
        order=list(best.order),
        legs=legs,
        depart_after=depart_after,
        now=now,
        safety_weight=w,
        buffer_min=buffer_min,
        cost_min=best.cost,
        baseline=_baseline(router, start, stops, earliest, buffer, view),
        feeds_down=view.feeds_down,
        freshness=view.freshness(),
    )
    plan.warnings = _warnings(plan, router)
    return plan


@dataclass
class Baseline:
    """Typed order, leave now, each leg as soon as ready, traffic-only routes (no train or
    crash awareness), judged with our full expected costs. What the plan is compared to."""

    drive_min: float
    wait_min: float
    late_stops: int


def _baseline(
    router: Router,
    start: Place,
    stops: list[StopRequest],
    earliest: datetime,
    buffer: timedelta,
    view: ConditionsView,
) -> Baseline:
    loc, t, drive, wait, late = start, earliest, 0.0, 0.0, 0
    for stop in stops:
        r = router.traffic_only_route(loc.node, stop.place.node, t, view=view)
        drive += r.total_s / 60
        arrive = r.arrive_at
        if stop.window_start and arrive < stop.window_start:
            wait += (stop.window_start - arrive).total_seconds() / 60
        if stop.window_end and arrive > stop.window_end:
            late += 1
        service = max(arrive, stop.window_start) if stop.window_start else arrive
        t = service + timedelta(minutes=stop.dwell_min)
        loc = stop.place
    return Baseline(drive, wait, late)


def _warnings(plan: Plan, router: Router) -> list[str]:
    out = []
    for place in [plan.start] + [s.place for s in plan.stops]:
        if place.snapped_km > FAR_SNAP_KM:
            node = router.network.nodes[place.node].name
            out.append(
                f"{place.name} is {place.snapped_km:.1f} km from the nearest point on our road map "
                f"({node}); that stretch isn't modeled yet"
            )
    for leg in plan.late_stops:
        out.append(f"Can't reach {leg.to.name} before its window ends: about {leg.late_min:.0f} min late")
    for leg in plan.legs:
        if leg.tight and not leg.late_min:
            out.append(f"{leg.to.name} is tight: less than {plan.buffer_min} min to spare")
    names = {"trains": "Train", "traffic": "Live traffic", "incidents": "Incident"}
    for feed in plan.feeds_down:
        out.append(f"{names.get(feed, feed)} feed is down; using predictions")
    return out
