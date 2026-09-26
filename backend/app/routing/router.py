"""Time-dependent routing with a blended cost (travel time + train delay + crash risk).

For departure time t, each segment is scored at the moment you'd actually reach it, using
only the road-conditions layer (app.conditions), which merges predictions with live data:

    edge_cost = travel_time(seg, t_seg)                         # predicted, blended with live traffic
              + sum(expected_train_delay(crossing, t_crossing))  # live status first, then prediction
              + lambda(safety_weight) * crash_risk(seg, t_seg) * seg_miles

    lambda = 30 s/mile at safety_weight 0 ... 600 s/mile at safety_weight 1

A closed road is a wait: you reach it, wait for the closure to clear, then drive it (like
waiting at a blocked crossing), so the search either waits or goes around, whichever is
cheaper, and a closure never makes a trip impossible. The search minimizes cost; ETA only
counts real time.
"""

import heapq
import itertools
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from app.conditions.live import Confidence, Incident, worst
from app.conditions.provider import LIVE_WINDOW, ConditionsProvider, ConditionsView
from app.graph import Network, SegmentInfo
from app.scoring import Models

# Seconds of penalty per mile at crash risk 1.0, at the two ends of the safety slider.
LAMBDA_CRASH = 30.0
LAMBDA_CRASH_SAFE = 600.0
SAFE_PATH_WEIGHT = 1.0  # what the old on/off "Safe Path" maps to
SAFE_MODE_WEIGHT = 0.5  # from here on we talk about the route as a safety-first route
ALT_PENALTY = 1.5  # cost multiplier on the best route's segments when looking for an alternative

TRAIN_REASON_P = 0.25
CRASH_REASON_RISK = 0.45
CONGESTION_REASON_SCORE = 0.5
LIVE_REASON_EXTRA = 0.15  # live congestion this much above the prediction is worth saying
SAFE_REASON_MIN_DROP = 0.05  # don't brag about a crash-exposure drop smaller than this
MAX_REASONS = 7
MAX_CLOSURE_WAITS = 3  # back-to-back closures on one road before we treat it as impassable

SOURCE_LABELS = {
    "trainwatch": "Train Watch",
    "transtar_rss": "TranStar",
    "camera": "traffic camera",
    "demo": "demo feed",
    "history": "history",
}


def resolve_safety(safe_path: bool | None = None, safety_weight: float | None = None) -> float:
    """safety_weight wins; the old boolean maps to 1.0 (on) or 0.0 (off)."""
    if safety_weight is not None:
        return min(1.0, max(0.0, float(safety_weight)))
    return SAFE_PATH_WEIGHT if safe_path else 0.0


def crash_lambda(safety_weight: float) -> float:
    return LAMBDA_CRASH + safety_weight * (LAMBDA_CRASH_SAFE - LAMBDA_CRASH)


@dataclass
class CrossingOnRoute:
    id: str
    name: str
    lat: float
    lng: float
    arrive_at: datetime
    block_probability: float
    expected_delay_s: float
    live: bool
    confidence: Confidence = "medium"
    source: str = "history"
    updated_at: datetime | None = None
    sensor_up: bool | None = None


@dataclass
class SegmentOnRoute:
    id: str
    name: str
    road_class: str
    enter_at: datetime
    travel_s: float
    train_delay_s: float
    congestion: float
    crash_risk: float
    miles: float
    geometry: list[list[float]]
    crossings: list[CrossingOnRoute] = field(default_factory=list)
    predicted_congestion: float = 0.0
    congestion_source: str = "history"
    live_weight: float = 0.0
    live_updated_at: datetime | None = None
    live_detail: str = ""
    incident: Incident | None = None
    incident_slowdown: float = 1.0
    closed: bool = False  # impassable (never on a returned route)
    confidence: Confidence = "medium"
    closure: Incident | None = None  # closed when you reach it; the route waits for it to reopen
    closure_wait_s: float = 0.0

    @property
    def reopens_at(self) -> datetime:
        return self.enter_at + timedelta(seconds=self.closure_wait_s)


@dataclass
class Route:
    origin: str
    destination: str
    depart_at: datetime
    arrive_at: datetime
    safety_weight: float
    segments: list[SegmentOnRoute]
    free_flow_s: float
    base_travel_s: float
    train_delay_s: float
    crash_exposure: float  # sum of risk * miles
    cost: float
    confidence: Confidence = "medium"
    feeds_down: list[str] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)
    closure_wait_s: float = 0.0  # time spent waiting for closed roads to reopen

    @property
    def safe_path(self) -> bool:
        return self.safety_weight >= SAFE_MODE_WEIGHT

    @property
    def total_s(self) -> float:
        return (self.arrive_at - self.depart_at).total_seconds()

    @property
    def segment_ids(self) -> list[str]:
        return [s.id for s in self.segments]

    @property
    def crossings(self) -> list[CrossingOnRoute]:
        return [c for s in self.segments for c in s.crossings]

    @property
    def max_block_probability(self) -> float:
        return max((c.block_probability for c in self.crossings), default=0.0)

    @property
    def max_crash_risk(self) -> float:
        return max((s.crash_risk for s in self.segments), default=0.0)

    @property
    def uses_live(self) -> bool:
        return any(s.live_weight > 0 or s.incident or s.closure for s in self.segments) or any(
            c.live for c in self.crossings
        )

    @property
    def geometry(self) -> list[list[float]]:
        pts: list[list[float]] = []
        for s in self.segments:
            pts.extend(s.geometry if not pts else s.geometry[1:])
        return pts


class NoRouteError(ValueError):
    pass


def _fmt(t: datetime) -> str:
    return t.strftime("%-I:%M %p")


def _label(source: str) -> str:
    parts = source.removeprefix("live:").split("+")
    return " + ".join(SOURCE_LABELS.get(p, p) for p in parts)


def _ago(updated: datetime | None, now: datetime) -> str:
    if updated is None:
        return ""
    minutes = max(0, round((now - updated).total_seconds() / 60))
    return "just now" if minutes == 0 else f"{minutes} min ago"


def _provenance(source: str, updated: datetime | None, now: datetime) -> str:
    ago = _ago(updated, now)
    return f"{_label(source)}, {ago}" if ago else _label(source)


def _dedupe_live(reasons: list[str]) -> list[str]:
    """Drop repeats, and "Avoided X: ..." when "Rerouted around X" already says it."""
    rerouted = {r.split(":")[0].removeprefix("Rerouted around ") for r in reasons if r.startswith("Rerouted around ")}
    out = []
    for r in dict.fromkeys(reasons):
        name = r.split(":")[0].removeprefix("Avoided ")
        if r.startswith("Avoided ") and name in rerouted and "right now" in r:
            continue
        out.append(r)
    return out[:MAX_REASONS]


class Router:
    def __init__(self, network: Network, models: Models, conditions: ConditionsProvider | None = None) -> None:
        self.network = network
        self.models = models
        # Without a provider (tests, scripts) routing uses predictions only.
        self.conditions = conditions or ConditionsProvider(network, models)

    def view(self, now: datetime | None = None) -> ConditionsView:
        """Live conditions as of now. Build one per request so every search in it sees the
        same data (and live feeds are pulled once)."""
        return self.conditions.view(now)

    def _view_for(self, view: ConditionsView | None, depart_at: datetime) -> ConditionsView:
        if view is not None:
            return view
        if self.conditions.has_clock:
            return self.conditions.view()
        return self.conditions.view(depart_at, live=False)  # no clock: predictions only

    # --- per-segment evaluation -----------------------------------------------------------

    def _eval_segment(self, seg: SegmentInfo, enter_at: datetime, view: ConditionsView) -> SegmentOnRoute:
        sc = view.segment(seg, enter_at)
        # Closed when we get there: wait for it to clear, then drive it.
        closure, start = None, enter_at
        for _ in range(MAX_CLOSURE_WAITS):
            if not (sc.closed and sc.incident):
                break
            reopen = view.incident_end(sc.incident)
            if reopen <= start:
                break
            closure, start = closure or sc.incident, reopen
            sc = view.segment(seg, start)
        crossings = []
        delay = 0.0
        for c in self.network.crossings_on.get(seg.id, []):
            cc = view.crossing(c, start + timedelta(seconds=sc.travel_s / 2))
            crossings.append(
                CrossingOnRoute(
                    c.id, c.name, c.lat, c.lng, cc.arrive_at, cc.block_probability, cc.expected_delay_s,
                    cc.live, cc.confidence, cc.source, cc.updated_at, cc.sensor_up,
                )
            )
            delay += cc.expected_delay_s
        return SegmentOnRoute(
            id=seg.id,
            name=seg.name,
            road_class=seg.road_class,
            enter_at=enter_at,
            travel_s=sc.travel_s,
            train_delay_s=delay,
            congestion=sc.congestion,
            crash_risk=sc.crash_risk,
            miles=seg.length_miles,
            geometry=[list(p) for p in seg.geometry],
            crossings=crossings,
            predicted_congestion=sc.predicted_congestion,
            congestion_source=sc.congestion_source,
            live_weight=sc.live_weight,
            live_updated_at=sc.live_updated_at,
            live_detail=sc.live_detail,
            incident=sc.incident,
            incident_slowdown=sc.incident_slowdown,
            closed=sc.closed,
            confidence=sc.confidence,
            closure=closure,
            closure_wait_s=(start - enter_at).total_seconds(),
        )

    @staticmethod
    def _time(s: SegmentOnRoute) -> float:
        """Real seconds spent on the segment: closure wait + driving + train delay."""
        return s.closure_wait_s + s.travel_s + s.train_delay_s

    @classmethod
    def _cost(cls, s: SegmentOnRoute, lam: float) -> float:
        return cls._time(s) + lam * s.crash_risk * s.miles

    # --- search ---------------------------------------------------------------------------

    def _search(
        self,
        origin: str,
        destination: str,
        depart_at: datetime,
        lam: float,
        view: ConditionsView,
        penalties: dict[str, float] | None = None,
        blind: bool = False,
    ) -> list[str]:
        """Returns segment ids. `blind=True` routes on traffic only (live traffic and
        incidents included, trains and crash risk ignored): roughly what a typical nav app
        picks. Used to explain what we avoided."""
        if origin not in self.network.nodes or destination not in self.network.nodes:
            raise NoRouteError(f"unknown node {origin!r} or {destination!r}")
        penalties = penalties or {}
        # Label-setting search over (time so far, penalty so far), penalty = cost - time
        # (crash penalty, alternative-route multipliers). One label per node isn't enough
        # once roads can be waited on: reaching a closed road later means waiting less, so
        # a path that looks worse halfway can be the better one. A label is dropped only
        # when another reached the same node no later and with no more penalty.
        fronts: dict[str, list[tuple[float, float]]] = {origin: [(0.0, 0.0)]}
        tie = itertools.count()
        heap: list = [(0.0, 0.0, next(tie), origin, (), frozenset((origin,)))]
        while heap:
            cost, elapsed, _, node, path, visited = heapq.heappop(heap)
            if node == destination:
                return list(path)
            now = depart_at + timedelta(seconds=elapsed)
            for seg in self.network.out_edges.get(node, []):
                if seg.to_node in visited:
                    continue
                s = self._eval_segment(seg, now, view)
                if s.closed:
                    continue
                if blind:
                    # A traffic-only app doesn't know about trains: its clock and its cost are
                    # both just traffic (+ closures), so it never "uses up" a closure wait on a
                    # train. evaluate() charges the real train delay afterwards.
                    step_time = step_cost = s.closure_wait_s + s.travel_s
                else:
                    step_time, step_cost = self._time(s), self._cost(s, lam)
                step_cost *= penalties.get(seg.id, 1.0)
                new_elapsed, new_cost = elapsed + step_time, cost + step_cost
                new_penalty = new_cost - new_elapsed
                front = fronts.setdefault(seg.to_node, [])
                if any(e <= new_elapsed + 1e-6 and p <= new_penalty + 1e-6 for e, p in front):
                    continue
                front[:] = [(e, p) for e, p in front if not (new_elapsed <= e and new_penalty <= p)]
                front.append((new_elapsed, new_penalty))
                heapq.heappush(
                    heap, (new_cost, new_elapsed, next(tie), seg.to_node, (*path, seg.id), visited | {seg.to_node})
                )
        raise NoRouteError(f"no open route from {origin} to {destination}")

    def evaluate(
        self,
        segment_ids: list[str],
        origin: str,
        destination: str,
        depart_at: datetime,
        safety_weight: float,
        view: ConditionsView,
    ) -> Route:
        lam = crash_lambda(safety_weight)
        t = depart_at
        segs = []
        for sid in segment_ids:
            s = self._eval_segment(self.network.segments[sid], t, view)
            segs.append(s)
            t += timedelta(seconds=self._time(s))
        route = Route(
            origin=origin,
            destination=destination,
            depart_at=depart_at,
            arrive_at=t,
            safety_weight=safety_weight,
            segments=segs,
            free_flow_s=sum(self.network.segments[sid].free_flow_seconds for sid in segment_ids),
            base_travel_s=sum(s.travel_s for s in segs),
            train_delay_s=sum(s.train_delay_s for s in segs),
            crash_exposure=sum(s.crash_risk * s.miles for s in segs),
            cost=sum(self._cost(s, lam) for s in segs),
            feeds_down=view.feeds_down,
            closure_wait_s=sum(s.closure_wait_s for s in segs),
        )
        route.confidence = self._route_confidence(route)
        return route

    @staticmethod
    def _route_confidence(route: Route) -> Confidence:
        """low: something that matters rests on a low-confidence input (sensor down, stale or
        low-confidence live data, a down feed in the next 30 min).
        high: most of the drive is backed by strong live readings and no crossing is a gamble.
        medium: predictions (the normal case)."""
        levels: list[Confidence] = []
        for s in route.segments:
            if s.live_weight > 0 or s.incident or s.closure or s.confidence == "low":
                levels.append(s.confidence)
        for c in route.crossings:
            if c.live or c.block_probability >= TRAIN_REASON_P or c.confidence == "low":
                levels.append(c.confidence)
        if levels and worst(*levels) == "low":
            return "low"
        total = sum(s.travel_s for s in route.segments) or 1.0
        live_share = sum(s.travel_s for s in route.segments if s.live_weight >= 0.4) / total
        risky = any(not c.live and c.block_probability >= 0.1 for c in route.crossings)
        if live_share >= 0.5 and not risky:
            return "high"
        return "medium"

    # --- public API -----------------------------------------------------------------------

    def best_route(
        self,
        origin: str,
        destination: str,
        depart_at: datetime,
        safe_path: bool = False,
        safety_weight: float | None = None,
        view: ConditionsView | None = None,
    ) -> Route:
        """Best route only (no alternative / reasons); cheap enough to call in a loop."""
        view = self._view_for(view, depart_at)
        w = resolve_safety(safe_path, safety_weight)
        ids = self._search(origin, destination, depart_at, crash_lambda(w), view)
        return self.evaluate(ids, origin, destination, depart_at, w, view)

    def traffic_only_route(
        self, origin: str, destination: str, depart_at: datetime, view: ConditionsView | None = None
    ) -> Route:
        """What a traffic-only nav app would pick, evaluated with our full expected costs."""
        view = self._view_for(view, depart_at)
        ids = self._search(origin, destination, depart_at, crash_lambda(0.0), view, blind=True)
        return self.evaluate(ids, origin, destination, depart_at, 0.0, view)

    def route(
        self,
        origin: str,
        destination: str,
        depart_at: datetime,
        safe_path: bool = False,
        safety_weight: float | None = None,
        view: ConditionsView | None = None,
    ) -> tuple[Route, Route | None]:
        """Best route and (if one exists) a meaningfully different alternative."""
        view = self._view_for(view, depart_at)
        w = resolve_safety(safe_path, safety_weight)
        lam = crash_lambda(w)
        best_ids = self._search(origin, destination, depart_at, lam, view)
        best = self.evaluate(best_ids, origin, destination, depart_at, w, view)

        naive_ids = self._search(origin, destination, depart_at, lam, view, blind=True)
        naive = self.evaluate(naive_ids, origin, destination, depart_at, w, view)
        best.reasons = _dedupe_live(
            self._live_reasons(origin, destination, depart_at, lam, view, best) + self._reasons(best, naive, view)
        )

        alt = None
        alt_ids = self._search(
            origin, destination, depart_at, lam, view, penalties={sid: ALT_PENALTY for sid in best_ids}
        )
        if alt_ids != best_ids:
            alt = self.evaluate(alt_ids, origin, destination, depart_at, w, view)
            alt.reasons = _dedupe_live(self._reasons(alt, naive, view))
        return best, alt

    # --- explanations ---------------------------------------------------------------------

    def _live_reasons(
        self,
        origin: str,
        destination: str,
        depart_at: datetime,
        lam: float,
        view: ConditionsView,
        chosen: Route,
    ) -> list[str]:
        """If live data changed our pick, say what we routed around and where the data came from."""
        if not view.has_live:
            return []
        try:
            usual_ids = self._search(origin, destination, depart_at, lam, view.without_live())
        except NoRouteError:
            return []
        if usual_ids == chosen.segment_ids:
            return []
        usual = self.evaluate(usual_ids, origin, destination, depart_at, chosen.safety_weight, view)
        on_route = set(chosen.segment_ids)
        chosen_crossings = {c.id for c in chosen.crossings}
        now = view.now
        out = []
        for c in usual.crossings:
            if c.live and c.block_probability >= 1.0 and c.id not in chosen_crossings:
                note = "" if c.sensor_up is not False else "; sensor down, low confidence"
                out.append(
                    f"Rerouted around {c.name}: blocked by a train right now "
                    f"(~{c.expected_delay_s / 60:.0f} min wait; {_provenance(c.source, c.updated_at, now)}{note})"
                )
        for s in usual.segments:
            if s.id in on_route:
                continue
            closure = s.closure or (s.incident if s.closed else None)
            if closure:
                until = "" if s.closed else f" until about {_fmt(s.reopens_at)}"
                out.append(
                    f"Rerouted around {s.name}: closed{until} ({closure.title}; "
                    f"{_provenance(closure.source, closure.updated_at, now)})"
                )
            elif s.incident:
                out.append(
                    f"Rerouted around {s.name}: {s.incident.kind} reported "
                    f"({_provenance(s.incident.source, s.incident.updated_at, now)})"
                )
            elif s.live_weight >= 0.3 and s.congestion - s.predicted_congestion >= LIVE_REASON_EXTRA:
                out.append(
                    f"Rerouted around {s.name}: heavier traffic than usual right now "
                    f"({_provenance(s.congestion_source, s.live_updated_at, now)})"
                )
        return list(dict.fromkeys(out))

    @staticmethod
    def _skipped_stretches(naive: Route, on_route: set[str]) -> list[list[SegmentOnRoute]]:
        """Runs of consecutive traffic-only-route segments on the same road that we skip."""
        stretches: list[list[SegmentOnRoute]] = []
        prev_skipped = False
        for s in naive.segments:
            skipped = s.id not in on_route
            if skipped and prev_skipped and stretches[-1][-1].name == s.name:
                stretches[-1].append(s)
            elif skipped:
                stretches.append([s])
            prev_skipped = skipped
        # One reason per road: keep the first stretch of each.
        seen: set[str] = set()
        return [st for st in stretches if not (st[0].name in seen or seen.add(st[0].name))]

    def _place(self, segment_id: str, end: str) -> str:
        seg = self.network.segments[segment_id]
        name = self.network.nodes[seg.from_node if end == "from" else seg.to_node].name
        return name.removeprefix(f"{seg.name} @ ")

    def _reasons(self, chosen: Route, naive: Route, view: ConditionsView) -> list[str]:
        reasons: list[str] = []
        on_route = set(chosen.segment_ids)
        chosen_crossings = {c.id for c in chosen.crossings}
        now = view.now

        # Hazards the traffic-only route would have hit.
        if naive.segment_ids != chosen.segment_ids:
            for c in naive.crossings:
                if c.id in chosen_crossings:
                    continue
                if c.live and c.block_probability >= 1.0:
                    reasons.append(
                        f"Avoided {c.name}: blocked by a train right now ({_provenance(c.source, c.updated_at, now)})"
                    )
                elif not c.live and c.block_probability >= TRAIN_REASON_P:
                    reasons.append(
                        f"Avoided {c.name}: {c.block_probability:.0%} chance of a train around {_fmt(c.arrive_at)}"
                    )
            chosen_roads = {s.name for s in chosen.segments}
            for stretch in self._skipped_stretches(naive, on_route):
                first = stretch[0]
                where = first.name
                if first.name in chosen_roads:  # we still drive part of it: name the stretch
                    where = f"{first.name} from {self._place(stretch[0].id, 'from')} to {self._place(stretch[-1].id, 'to')}"
                risk = max(s.crash_risk for s in stretch)
                jam = max(stretch, key=lambda s: s.congestion)
                if chosen.safe_path and risk >= CRASH_REASON_RISK:
                    reasons.append(f"Avoided {where}: crash risk {risk:.0%} around {_fmt(first.enter_at)}")
                elif jam.congestion >= CONGESTION_REASON_SCORE:
                    if jam.live_weight >= 0.3:
                        src = _provenance(jam.congestion_source, jam.live_updated_at, now)
                        reasons.append(f"Avoided {where}: heavy traffic right now ({src})")
                    else:
                        reasons.append(f"Avoided {where}: heavy congestion expected around {_fmt(first.enter_at)}")
            saved = (naive.arrive_at - chosen.arrive_at).total_seconds() / 60
            if saved >= 1:
                reasons.append(f"About {saved:.0f} min faster than a traffic-only route")
            if chosen.safety_weight > 0 and naive.crash_exposure > 0:
                drop = 1 - chosen.crash_exposure / naive.crash_exposure
                if drop >= SAFE_REASON_MIN_DROP:
                    extra = f" for +{-saved:.0f} min" if saved <= -1 else ""
                    label = "Safe Path" if chosen.safe_path else "Safety setting"
                    reasons.append(f"{label}: {drop:.0%} less crash exposure than the traffic-only route{extra}")

        # Heads-ups on the chosen route itself.
        for c in chosen.crossings:
            low = " (sensor down, low confidence)" if c.sensor_up is False else ""
            if c.live and c.block_probability >= 1.0:
                reasons.append(
                    f"{c.name} is blocked right now (+{c.expected_delay_s / 60:.0f} min; "
                    f"{_provenance(c.source, c.updated_at, now)}){low}"
                )
            elif not c.live and c.block_probability >= TRAIN_REASON_P:
                reasons.append(
                    f"Heads up: {c.block_probability:.0%} chance of a train at {c.name} around "
                    f"{_fmt(c.arrive_at)} (~{c.expected_delay_s / 60:.0f} min expected){low}"
                )
        seen_incidents: set[str] = set()
        for s in chosen.segments:
            if s.closure and s.closure_wait_s >= 60:
                reasons.append(
                    f"Heads up: {s.name} is closed until about {_fmt(s.reopens_at)} "
                    f"({_provenance(s.closure.source, s.closure.updated_at, now)}); this route waits "
                    f"~{s.closure_wait_s / 60:.0f} min for it to reopen"
                )
            inc = s.incident
            if inc and inc.id not in seen_incidents:
                seen_incidents.add(inc.id)
                extra = s.travel_s * (1 - 1 / s.incident_slowdown) / 60
                reasons.append(
                    f"Heads up: {inc.kind} on {s.name} ({_provenance(inc.source, inc.updated_at, now)}), "
                    f"about +{max(1, round(extra))} min"
                )
            elif not inc and s.live_weight >= 0.3 and s.congestion - s.predicted_congestion >= LIVE_REASON_EXTRA:
                reasons.append(
                    f"Heads up: {s.name} is slower than usual right now "
                    f"({_provenance(s.congestion_source, s.live_updated_at, now)})"
                )
        worst_crash: dict[str, float] = {}
        for s in chosen.segments:
            if s.crash_risk >= CRASH_REASON_RISK and s.road_class == "freeway":
                worst_crash[s.name] = max(worst_crash.get(s.name, 0.0), s.crash_risk)
        for name, risk in worst_crash.items():
            reasons.append(f"Heads up: elevated crash risk on {name} ({risk:.0%})")

        # Missing live feeds go first so the reason cap never hides them.
        notes = []
        soon = chosen.depart_at - now <= LIVE_WINDOW
        if soon and "trains" in chosen.feeds_down and chosen.crossings:
            notes.append("Live train data is unavailable right now; crossing waits are predictions")
        if soon and "traffic" in chosen.feeds_down:
            notes.append("Live traffic data is unavailable right now; using predicted traffic")
        if soon and "incidents" in chosen.feeds_down:
            notes.append("Incident feed is unavailable right now; crashes and closures may be missing")

        return list(dict.fromkeys(notes + reasons))
