"""Why traffic is slow: every slowdown on the network, what's causing it and how much.

For a road segment at time T the delay (vs. free flow) is split into parts, each with a cause:

    usual     predicted travel - free flow         "Rush hour" (weekday peaks) / "Usual traffic"
    volume    live-blended travel - predicted      "Higher than usual volume" (cameras, TranStar)
    incident  live travel x (incident factor - 1)  crash / stall / construction / lane closure /
                                                   event / weather ...
    closure   wait until a closed road reopens     "Road closure"
    train     expected wait at its rail crossings  "Train"

Status from effective speed vs. free-flow speed: heavy < 50%, moderate < 75%, else light. A
segment is a slowdown when it's moderate or heavy, or at least 3 min slower than free flow.
Everything is read from one ConditionsView, so it agrees with what the router sees.
"""

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from app.conditions.live import Incident
from app.conditions.provider import ConditionsView
from app.graph import CrossingInfo, Network, SegmentInfo
from app.routing.router import SOURCE_LABELS, Router

HEAVY_RATIO = 0.5
MODERATE_RATIO = 0.75
MIN_DELAY_S = 3 * 60
FEATURE_SHARE = 25  # a non-routine cause with at least this share of the delay is "the" cause
TOP_ROUTINE = 3  # routine (rush hour) slowdowns highlighted on the map
MIN_TRAIN_S = 30
HISTORY_SPAN = timedelta(hours=2)
HISTORY_STEP = timedelta(minutes=10)
EASE_HORIZON = timedelta(hours=4)
MARKER_OFFSET_M = 55  # same right-of-travel offset the map draws each direction with

# Weekday rush windows (local time): (start, end) in minutes after midnight.
RUSH_WINDOWS = ((6 * 60, 9 * 60 + 30, "morning"), (15 * 60 + 30, 19 * 60, "evening"))

# Incident kind -> (cause kind shown on the map, label)
INCIDENT_CAUSE = {
    "crash": ("crash", "Crash"),
    "stall": ("crash", "Stalled vehicle"),
    "hazard": ("crash", "Hazard on the road"),
    "other": ("crash", "Incident"),
    "roadwork": ("construction", "Construction"),
    "lane_closure": ("closure", "Lane closure"),
    "closure": ("closure", "Road closure"),
    "event": ("event", "Event"),
    "weather": ("weather", "Weather"),
}
CAUSE_LABELS = {
    "rush": "Rush hour",
    "usual": "Usual traffic",
    "volume": "Higher than usual volume",
    "crash": "Crash",
    "construction": "Construction",
    "closure": "Road closure",
    "event": "Event",
    "weather": "Weather",
    "train": "Train",
}
BOUND = {"N": "northbound", "NE": "northbound", "NW": "northbound", "S": "southbound", "SE": "southbound",
         "SW": "southbound", "E": "eastbound", "W": "westbound"}


def fmt(t: datetime) -> str:
    return t.strftime("%-I:%M %p")


def _hour_label(t: datetime) -> str:
    return t.strftime("%-I %p") if t.minute < 30 else (t + timedelta(hours=1)).strftime("%-I %p")


@dataclass
class Cause:
    kind: str  # rush | usual | volume | crash | construction | closure | event | weather | train
    label: str
    seconds: float
    title: str
    detail: str
    started_at: datetime | None = None
    source: str = "history"
    incident_id: str | None = None
    crossing_id: str | None = None
    pct: int = 0


@dataclass
class Slowdown:
    id: str  # segment id
    segment: SegmentInfo
    at: datetime
    road: str
    place: str
    level: str  # heavy | moderate | light
    closed: bool
    delay_s: float
    speed_mph: float
    free_flow_mph: float
    usual_mph: float
    lat: float
    lng: float
    causes: list[Cause] = field(default_factory=list)
    highlight: bool = False  # worth an icon on the map

    @property
    def main(self) -> Cause:
        """The cause to lead with: a non-routine one (crash, train, rain...) with a real share
        of the delay, otherwise the biggest."""
        special = next((c for c in self.causes if c.kind != "rush" and c.pct >= FEATURE_SHARE), None)
        return special or self.causes[0]

    @property
    def routine(self) -> bool:
        return self.main.kind == "rush"

    @property
    def delay_min(self) -> int:
        return round(self.delay_s / 60)

    @property
    def is_slowdown(self) -> bool:
        return self.closed or self.level != "light" or self.delay_s >= MIN_DELAY_S


class CausesEngine:
    def __init__(self, router: Router, view: ConditionsView | None = None) -> None:
        self.router = router
        self.network: Network = router.network
        self.models = router.models
        self.view = view or router.view()
        self.now = self.view.now

    # --- one segment ------------------------------------------------------------------------

    def analyze(self, seg: SegmentInfo, at: datetime | None = None) -> Slowdown:
        at = at or self.now
        view, cong = self.view, self.models.congestion
        sc = view.segment(seg, at)
        free_s = seg.free_flow_seconds
        usual_s = cong.travel_time_for_score(seg.id, sc.predicted_congestion)
        live_s = sc.travel_s / sc.incident_slowdown if sc.incident_slowdown else sc.travel_s
        causes: list[Cause] = []

        usual_part = max(0.0, min(usual_s, live_s) - free_s)
        if usual_part > 0:
            causes.append(self._usual_cause(seg, at, usual_part))
        volume_part = max(0.0, live_s - usual_s)
        if volume_part > 0 and sc.live_weight > 0:
            src = sc.congestion_source.removeprefix("live:")
            label = " + ".join(SOURCE_LABELS.get(p, p) for p in src.split("+"))
            ago = max(0, round((self.now - sc.live_updated_at).total_seconds() / 60)) if sc.live_updated_at else 0
            causes.append(
                Cause(
                    "volume",
                    CAUSE_LABELS["volume"],
                    volume_part,
                    "Heavier than usual",
                    f"More traffic than usual for this time ({label}, {'just now' if ago == 0 else f'{ago} min ago'})"
                    + (f": {sc.live_detail}" if sc.live_detail else ""),
                    started_at=sc.live_updated_at,
                    source=src,
                )
            )
        if sc.incident is not None and sc.incident_slowdown > 1:
            causes.append(self._incident_cause(sc.incident, live_s * (sc.incident_slowdown - 1), view))
        closed = False
        if sc.closed and sc.incident is not None:
            closed = True
            reopen = view.incident_end(sc.incident)
            wait = max(0.0, (reopen - at).total_seconds())
            cause = self._incident_cause(sc.incident, wait, view)
            cause.detail = f"Closed until about {fmt(reopen)}. " + cause.detail
            causes.append(cause)
        for c in self.network.crossings_on.get(seg.id, []):
            cause = self._train_cause(c, at + timedelta(seconds=sc.travel_s / 2))
            if cause is not None:
                causes.append(cause)

        delay = sum(c.seconds for c in causes)
        actual_s = free_s + delay
        ratio = free_s / actual_s if actual_s > 0 else 1.0
        level = "heavy" if closed or ratio < HEAVY_RATIO else "moderate" if ratio < MODERATE_RATIO else "light"
        causes.sort(key=lambda c: -c.seconds)
        _set_shares(causes)
        lat, lng = _marker_point(seg)
        miles = seg.length_miles
        return Slowdown(
            id=seg.id,
            segment=seg,
            at=at,
            road=f"{seg.name} {BOUND.get(seg.direction, '')}".strip(),
            place=f"{self._node(seg.from_node, seg)} to {self._node(seg.to_node, seg)}",
            level=level,
            closed=closed,
            delay_s=delay,
            speed_mph=0.0 if closed else miles / (actual_s / 3600),
            free_flow_mph=seg.free_flow_mph,
            usual_mph=miles / (usual_s / 3600),
            lat=lat,
            lng=lng,
            causes=causes,
        )

    def _node(self, node_id: str, seg: SegmentInfo) -> str:
        name = self.network.nodes[node_id].name
        return name.removeprefix(f"{seg.name} @ ")

    def _usual_cause(self, seg: SegmentInfo, at: datetime, seconds: float) -> Cause:
        minutes = at.hour * 60 + at.minute
        rush = at.weekday() < 5 and next((w for s, e, w in RUSH_WINDOWS if s <= minutes < e), None)
        eases = self._eases_at(seg, at)
        until = f"until about {fmt(eases)}" if eases else "for the next few hours"
        if rush:
            return Cause(
                "rush",
                CAUSE_LABELS["rush"],
                seconds,
                f"Normal {_hour_label(at)} traffic",
                f"Weekday {rush} rush. Traffic this heavy is typical here {until}.",
            )
        return Cause(
            "rush",
            CAUSE_LABELS["usual"],
            seconds,
            f"Usual {at.strftime('%A')} traffic",
            f"This stretch is usually this slow around {_hour_label(at)}; it typically eases {until}.",
        )

    def _eases_at(self, seg: SegmentInfo, at: datetime) -> datetime | None:
        """When the predicted speed gets back above the moderate threshold."""
        cong = self.models.congestion
        t = at
        while t - at <= EASE_HORIZON:
            t += timedelta(minutes=15)
            travel = cong.get_segment_travel_time(seg.id, t)
            if seg.free_flow_seconds / travel >= MODERATE_RATIO:
                return t.replace(minute=(t.minute // 15) * 15, second=0, microsecond=0)
        return None

    def _incident_cause(self, inc: Incident, seconds: float, view: ConditionsView) -> Cause:
        kind, label = INCIDENT_CAUSE.get(inc.kind, INCIDENT_CAUSE["other"])
        ends = view.incident_end(inc)
        lanes = f"{inc.lanes_blocked} lane{'s' if inc.lanes_blocked != 1 else ''} blocked"
        if inc.detail:
            detail = inc.detail
        elif kind == "crash":
            detail = f"{lanes}. Reported at {fmt(inc.started_at)}."
        elif kind == "construction":
            detail = f"Lane shifts and narrow lanes, listed until {fmt(ends)}."
        elif kind == "event":
            detail = f"Expect crowded streets nearby until about {fmt(ends)}."
        elif kind == "weather":
            detail = f"Drivers slowing for the weather. Reported at {fmt(inc.started_at)}."
        elif inc.kind == "lane_closure":
            detail = f"{lanes}, listed until {fmt(ends)}."
        else:
            detail = f"Reported at {fmt(inc.started_at)}."
        return Cause(kind, label, seconds, inc.title or label, detail, inc.started_at, inc.source, incident_id=inc.id)

    def _train_cause(self, c: CrossingInfo, arrive: datetime) -> Cause | None:
        cc = self.view.crossing(c, arrive)
        st = self.view.live.crossings.get(c.id)
        if cc.live and st is not None and st.blocked_since and arrive < st.blocked_since:
            # Routing counts a live train from now even for a time just before now (you can't
            # get there any sooner). For "what was it like at 4:50" it wasn't there yet.
            cc = self.view.without_live().crossing(c, arrive)
        if cc.expected_delay_s < MIN_TRAIN_S:
            return None
        if cc.live and cc.block_probability >= 1.0:
            avg = round(self.models.train.get_avg_block_minutes(c.id, arrive))
            clears = cc.clears_at or arrive + timedelta(seconds=cc.expected_delay_s)
            return Cause(
                "train",
                CAUSE_LABELS["train"],
                cc.expected_delay_s,
                "Freight train blocking crossing",
                f"{c.name} is blocked; expected to clear about {fmt(clears)}. "
                f"Crossings like this usually clear in about {avg} minutes.",
                started_at=(st.blocked_since if st else None) or cc.updated_at,
                source=cc.source,
                crossing_id=c.id,
            )
        return Cause(
            "train",
            CAUSE_LABELS["train"],
            cc.expected_delay_s,
            "Train likely at the crossing",
            f"{cc.block_probability:.0%} chance of a train at {c.name} around {fmt(arrive)}.",
            crossing_id=c.id,
        )

    # --- the whole network --------------------------------------------------------------------

    def slowdowns(self) -> list[Slowdown]:
        out = [self.analyze(seg) for seg in self.network.segments.values()]
        found = sorted((s for s in out if s.is_slowdown and s.causes), key=lambda s: -s.delay_s)
        routine = 0
        for s in found:
            if not s.routine:
                s.highlight = True
            elif routine < TOP_ROUTINE:
                s.highlight, routine = True, routine + 1
        return found

    def history(self, seg: SegmentInfo) -> list[tuple[datetime, float]]:
        """Speed every 10 min over the last 2 hours (live data only counts near now)."""
        points = []
        t = self.now - HISTORY_SPAN
        while t <= self.now:
            s = self.analyze(seg, t)
            points.append((t, s.speed_mph))
            t += HISTORY_STEP
        return points


def _set_shares(causes: list[Cause]) -> None:
    total = sum(c.seconds for c in causes)
    if total <= 0:
        return
    shares = [c.seconds / total * 100 for c in causes]
    rounded = [math.floor(x) for x in shares]
    # largest remainders so the shares add up to 100
    for i in sorted(range(len(shares)), key=lambda i: -(shares[i] - rounded[i]))[: 100 - sum(rounded)]:
        rounded[i] += 1
    for c, pct in zip(causes, rounded):
        c.pct = pct


def _marker_point(seg: SegmentInfo) -> tuple[float, float]:
    """Middle of the segment, shifted to the right of travel like the map draws it."""
    geom = seg.geometry
    n = len(geom)
    a, b = geom[(n - 1) // 2], geom[n // 2]
    lat, lng = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
    (y0, x0), (y1, x1) = geom[0], geom[-1]
    cos = math.cos(math.radians(y0))
    dx, dy = (x1 - x0) * cos, y1 - y0
    length = math.hypot(dx, dy) or 1.0
    k = MARKER_OFFSET_M / 111_320
    return lat + (-dx / length) * k, lng + (dy / length) * k / cos
