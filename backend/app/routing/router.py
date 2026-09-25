"""Time-dependent routing with a blended cost (travel time + train delay + crash risk).

For departure time t, each segment is scored at the moment you'd actually reach it:

    edge_cost = travel_time(seg, t_seg)
              + sum(expected_train_delay(crossing, t_crossing))
              + lambda_crash * crash_risk(seg, t_seg) * seg_miles

The search minimizes cost; ETA only counts real time (travel + train delay).
"""

import heapq
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from app.graph import Network, SegmentInfo
from app.scoring import Models
from app.seed.synthetic import TrainEvent

# Seconds of penalty per mile at crash risk 1.0.
LAMBDA_CRASH = 30.0
LAMBDA_CRASH_SAFE = 600.0
ALT_PENALTY = 1.5  # cost multiplier on the best route's segments when looking for an alternative

TRAIN_REASON_P = 0.25
CRASH_REASON_RISK = 0.45
CONGESTION_REASON_SCORE = 0.5


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


@dataclass
class Route:
    origin: str
    destination: str
    depart_at: datetime
    arrive_at: datetime
    safe_path: bool
    segments: list[SegmentOnRoute]
    free_flow_s: float
    base_travel_s: float
    train_delay_s: float
    crash_exposure: float  # sum of risk * miles
    cost: float
    reasons: list[str] = field(default_factory=list)

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
    def geometry(self) -> list[list[float]]:
        pts: list[list[float]] = []
        for s in self.segments:
            pts.extend(s.geometry if not pts else s.geometry[1:])
        return pts


class NoRouteError(ValueError):
    pass


def _fmt(t: datetime) -> str:
    return t.strftime("%-I:%M %p")


def _dedupe_live(reasons: list[str]) -> list[str]:
    """Drop repeats, and "Avoided X: blocked..." when "Rerouted around X" already says it."""
    rerouted = {r.split(":")[0].removeprefix("Rerouted around ") for r in reasons if r.startswith("Rerouted around ")}
    out = []
    for r in dict.fromkeys(reasons):
        name = r.split(":")[0].removeprefix("Avoided ")
        if r.startswith("Avoided ") and name in rerouted and "right now" in r:
            continue
        out.append(r)
    return out[:6]


class Router:
    def __init__(
        self,
        network: Network,
        models: Models,
        live_blockages: Callable[[], list[TrainEvent]] = lambda: [],
    ) -> None:
        self.network = network
        self.models = models
        self.live_blockages = live_blockages

    # --- per-segment evaluation -----------------------------------------------------------

    def _eval_segment(
        self, seg: SegmentInfo, enter_at: datetime, live: list[TrainEvent]
    ) -> SegmentOnRoute:
        m = self.models
        travel = m.congestion.get_segment_travel_time(seg.id, enter_at)
        crossings = []
        delay = 0.0
        for c in self.network.crossings_on.get(seg.id, []):
            reach = enter_at + timedelta(seconds=travel / 2)
            d = m.train.get_expected_delay(c.id, reach, live)
            is_live = any(e.crossing_id == c.id and e.start <= reach < e.end for e in live)
            p = 1.0 if is_live else m.train.get_block_probability(c.id, reach)
            crossings.append(CrossingOnRoute(c.id, c.name, c.lat, c.lng, reach, p, d, is_live))
            delay += d
        return SegmentOnRoute(
            id=seg.id,
            name=seg.name,
            road_class=seg.road_class,
            enter_at=enter_at,
            travel_s=travel,
            train_delay_s=delay,
            congestion=m.congestion.get_score(seg.id, enter_at),
            crash_risk=m.crash.get_crash_risk(seg.id, enter_at),
            miles=seg.length_miles,
            geometry=[list(p) for p in seg.geometry],
            crossings=crossings,
        )

    @staticmethod
    def _cost(s: SegmentOnRoute, lam: float) -> float:
        return s.travel_s + s.train_delay_s + lam * s.crash_risk * s.miles

    # --- search ---------------------------------------------------------------------------

    def _search(
        self,
        origin: str,
        destination: str,
        depart_at: datetime,
        lam: float,
        live: list[TrainEvent],
        penalties: dict[str, float] | None = None,
        blind: bool = False,
    ) -> list[str]:
        """Returns segment ids. `blind=True` routes on traffic only, ignoring trains and
        crash risk: roughly what a typical nav app picks. Used to explain what we avoided."""
        if origin not in self.network.nodes or destination not in self.network.nodes:
            raise NoRouteError(f"unknown node {origin!r} or {destination!r}")
        penalties = penalties or {}
        best: dict[str, float] = {origin: 0.0}
        prev: dict[str, tuple[str, str]] = {}
        heap = [(0.0, 0.0, origin)]
        done: set[str] = set()
        while heap:
            cost, elapsed, node = heapq.heappop(heap)
            if node in done:
                continue
            done.add(node)
            if node == destination:
                break
            now = depart_at + timedelta(seconds=elapsed)
            for seg in self.network.out_edges.get(node, []):
                if seg.to_node in done:
                    continue
                s = self._eval_segment(seg, now, live)
                if blind:
                    step_cost = step_time = s.travel_s
                else:
                    step_cost = self._cost(s, lam)
                    step_time = s.travel_s + s.train_delay_s
                step_cost *= penalties.get(seg.id, 1.0)
                new_cost = cost + step_cost
                if new_cost < best.get(seg.to_node, float("inf")):
                    best[seg.to_node] = new_cost
                    prev[seg.to_node] = (node, seg.id)
                    heapq.heappush(heap, (new_cost, elapsed + step_time, seg.to_node))
        if destination not in prev and origin != destination:
            raise NoRouteError(f"no route from {origin} to {destination}")
        path, node = [], destination
        while node != origin:
            node, sid = prev[node]
            path.append(sid)
        return path[::-1]

    def evaluate(
        self,
        segment_ids: list[str],
        origin: str,
        destination: str,
        depart_at: datetime,
        safe_path: bool,
        live: list[TrainEvent] | None = None,
    ) -> Route:
        live = self.live_blockages() if live is None else live
        lam = LAMBDA_CRASH_SAFE if safe_path else LAMBDA_CRASH
        t = depart_at
        segs = []
        for sid in segment_ids:
            s = self._eval_segment(self.network.segments[sid], t, live)
            segs.append(s)
            t += timedelta(seconds=s.travel_s + s.train_delay_s)
        return Route(
            origin=origin,
            destination=destination,
            depart_at=depart_at,
            arrive_at=t,
            safe_path=safe_path,
            segments=segs,
            free_flow_s=sum(self.network.segments[sid].free_flow_seconds for sid in segment_ids),
            base_travel_s=sum(s.travel_s for s in segs),
            train_delay_s=sum(s.train_delay_s for s in segs),
            crash_exposure=sum(s.crash_risk * s.miles for s in segs),
            cost=sum(self._cost(s, lam) for s in segs),
        )

    # --- public API -----------------------------------------------------------------------

    def best_route(self, origin: str, destination: str, depart_at: datetime, safe_path: bool = False) -> Route:
        """Best route only (no alternative / reasons); cheap enough to call in a loop."""
        live = self.live_blockages()
        lam = LAMBDA_CRASH_SAFE if safe_path else LAMBDA_CRASH
        ids = self._search(origin, destination, depart_at, lam, live)
        return self.evaluate(ids, origin, destination, depart_at, safe_path, live)

    def route(
        self, origin: str, destination: str, depart_at: datetime, safe_path: bool = False
    ) -> tuple[Route, Route | None]:
        """Best route and (if one exists) a meaningfully different alternative."""
        live = self.live_blockages()
        lam = LAMBDA_CRASH_SAFE if safe_path else LAMBDA_CRASH
        best_ids = self._search(origin, destination, depart_at, lam, live)
        best = self.evaluate(best_ids, origin, destination, depart_at, safe_path, live)

        naive_ids = self._search(origin, destination, depart_at, lam, live, blind=True)
        naive = self.evaluate(naive_ids, origin, destination, depart_at, safe_path, live)
        best.reasons = self._live_reasons(origin, destination, depart_at, lam, live, best) + self._reasons(
            best, naive
        )
        best.reasons = _dedupe_live(best.reasons)

        alt = None
        alt_ids = self._search(
            origin, destination, depart_at, lam, live, penalties={sid: ALT_PENALTY for sid in best_ids}
        )
        if alt_ids != best_ids:
            alt = self.evaluate(alt_ids, origin, destination, depart_at, safe_path, live)
            alt.reasons = self._reasons(alt, naive)
        return best, alt

    def _live_reasons(
        self,
        origin: str,
        destination: str,
        depart_at: datetime,
        lam: float,
        live: list[TrainEvent],
        chosen: Route,
    ) -> list[str]:
        """If a live blockage changed our pick, say which crossing we routed around."""
        if not live:
            return []
        usual_ids = self._search(origin, destination, depart_at, lam, [])
        if usual_ids == chosen.segment_ids:
            return []
        usual = self.evaluate(usual_ids, origin, destination, depart_at, chosen.safe_path, live)
        chosen_crossings = {c.id for c in chosen.crossings}
        return [
            f"Rerouted around {c.name}: blocked by a train right now (~{c.expected_delay_s / 60:.0f} min wait)"
            for c in usual.crossings
            if c.live and c.id not in chosen_crossings
        ]

    def _reasons(self, chosen: Route, naive: Route) -> list[str]:
        reasons: list[str] = []
        on_route = set(chosen.segment_ids)
        chosen_crossings = {c.id for c in chosen.crossings}

        # Hazards the traffic-only route would have hit.
        if naive.segment_ids != chosen.segment_ids:
            for c in naive.crossings:
                if c.id not in chosen_crossings and (c.live or c.block_probability >= TRAIN_REASON_P):
                    what = "blocked by a train right now" if c.live else (
                        f"{c.block_probability:.0%} chance of a train around {_fmt(c.arrive_at)}"
                    )
                    reasons.append(f"Avoided {c.name}: {what}")
            for s in naive.segments:
                if s.id in on_route:
                    continue
                if chosen.safe_path and s.crash_risk >= CRASH_REASON_RISK:
                    reasons.append(f"Avoided {s.name}: crash risk {s.crash_risk:.0%} around {_fmt(s.enter_at)}")
                elif s.congestion >= CONGESTION_REASON_SCORE:
                    reasons.append(f"Avoided {s.name}: heavy congestion expected around {_fmt(s.enter_at)}")
            saved = (naive.arrive_at - chosen.arrive_at).total_seconds() / 60
            if saved >= 1:
                reasons.append(f"About {saved:.0f} min faster than a traffic-only route")

        # Heads-ups on the chosen route itself.
        for c in chosen.crossings:
            if c.live:
                reasons.append(f"{c.name} is blocked right now (+{c.expected_delay_s / 60:.0f} min)")
            elif c.block_probability >= TRAIN_REASON_P:
                reasons.append(
                    f"Heads up: {c.block_probability:.0%} chance of a train at {c.name} around "
                    f"{_fmt(c.arrive_at)} (~{c.expected_delay_s / 60:.0f} min expected)"
                )
        for s in chosen.segments:
            if s.crash_risk >= CRASH_REASON_RISK and s.road_class == "freeway":
                reasons.append(f"Heads up: elevated crash risk on {s.name} ({s.crash_risk:.0%})")

        seen, unique = set(), []
        for r in reasons:
            if r not in seen:
                seen.add(r)
                unique.append(r)
        return unique[:6]
