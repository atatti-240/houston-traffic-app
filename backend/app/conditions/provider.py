"""Road conditions: what a road or crossing costs if you reach it at time T, and how sure we are.

The router asks only this module. Predictions come from the scoring models; live data comes
from the live sources (crossing status, live traffic, incidents). Priority rules:

Crossings (arriving at time T)
  1. Live "blocked" and T is before it clears  -> wait until it clears. Confidence high,
     or low when the crossing's sensor is down (still used, but flagged).
  2. Live "clear" with a working sensor and T within 5 min of now -> no wait.
  3. Otherwise the prediction: p_block x average blockage x 0.5. Confidence medium, or low
     when the sensor is down / its status is stale / the train feed is down and T is soon.

Road speed (entering at time T)
  - Live readings count only if fresh (10 min on freeways, 30 min on streets) and T is
    within 30 min of now. They are blended with the prediction:
        weight = 0.8 x (1 - minutes_ahead / 30) x confidence_factor
    so live data dominates right now and fades out by 30 min; one bad reading can't take over.
  - Otherwise the prediction from history.

Incidents
  - A closure removes the road. Other incidents slow it down (crash x1.6, roadwork x1.3,
    stall/hazard x1.2, +0.25 per extra blocked lane, max x3) until they clear. Without a
    clear time we assume 45 min from the start, and at least 15 more min from now.

Feeds down
  - A live source that raises is marked down; everything falls back to predictions and the
    affected inputs within the next 30 min are marked low confidence.
"""

from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from app.conditions.live import (
    CONFIDENCE_RANK,
    Confidence,
    CrossingStatus,
    FeedStatus,
    Incident,
    LiveTraffic,
)
from app.graph import CrossingInfo, Network, SegmentInfo

LIVE_WINDOW = timedelta(minutes=30)
LIVE_WEIGHT_MAX = 0.8
CONF_FACTOR: dict[str, float] = {"high": 1.0, "medium": 0.75, "low": 0.5}
MAX_LIVE_AGE = {"freeway": timedelta(minutes=10), "arterial": timedelta(minutes=30)}
CROSSING_STATUS_MAX_AGE = timedelta(minutes=15)
CLEAR_TRUST = timedelta(minutes=5)
INCIDENT_DEFAULT = timedelta(minutes=45)
INCIDENT_MIN_REMAINING = timedelta(minutes=15)
INCIDENT_SLOWDOWN = {"crash": 1.6, "roadwork": 1.3, "stall": 1.2, "hazard": 1.2, "other": 1.2}
EXTRA_LANE_SLOWDOWN = 0.25
MAX_INCIDENT_SLOWDOWN = 3.0
STRONG_LIVE_WEIGHT = 0.4  # live weight at which we call a reading "the" source

FEEDS = ("trains", "traffic", "incidents")


@dataclass
class SegmentCondition:
    segment_id: str
    enter_at: datetime
    travel_s: float
    congestion: float  # after blending, 0..1
    predicted_congestion: float
    congestion_source: str  # "history" or "live:<source>[+<source>]"
    live_weight: float  # 0 = prediction only
    live_updated_at: datetime | None
    live_detail: str
    crash_risk: float
    incident: Incident | None
    incident_slowdown: float
    closed: bool
    confidence: Confidence


@dataclass
class CrossingCondition:
    crossing_id: str
    arrive_at: datetime
    block_probability: float
    expected_delay_s: float
    live: bool  # decided by live status rather than the prediction
    sensor_up: bool | None  # None = no live status for this crossing
    confidence: Confidence
    source: str  # "history" or the live source name
    updated_at: datetime | None


@dataclass
class LiveState:
    now: datetime
    traffic: dict[str, list[LiveTraffic]] = field(default_factory=dict)
    incidents: list[Incident] = field(default_factory=list)
    crossings: dict[str, CrossingStatus] = field(default_factory=dict)
    feeds: dict[str, FeedStatus] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.incidents_on: dict[str, list[Incident]] = defaultdict(list)
        for inc in self.incidents:
            if inc.segment_id:
                self.incidents_on[inc.segment_id].append(inc)

    @property
    def has_data(self) -> bool:
        return bool(self.traffic or self.incidents_on or self.crossings)

    def feed_down(self, name: str) -> bool:
        f = self.feeds.get(name)
        return f is not None and not f.ok


class ConditionsView:
    """Conditions as known at one moment (`now`). Build one per routing request."""

    def __init__(self, provider: "ConditionsProvider", live: LiveState) -> None:
        self.provider = provider
        self.live = live
        self.now = live.now

    # --- roads ----------------------------------------------------------------------------

    def segment(self, seg: SegmentInfo, enter_at: datetime) -> SegmentCondition:
        models = self.provider.models
        now = self.now
        pred = models.congestion.get_score(seg.id, enter_at)
        ahead = enter_at - now

        congestion, source, weight, updated, detail = pred, "history", 0.0, None, ""
        confidence: Confidence = "medium" if models.congestion.has_history(seg.id, enter_at) else "low"

        max_age = MAX_LIVE_AGE.get(seg.road_class, MAX_LIVE_AGE["arterial"])
        fresh = [r for r in self.live.traffic.get(seg.id, ()) if timedelta(0) <= now - r.observed_at <= max_age]
        if fresh and ahead <= LIVE_WINDOW:
            total = sum(CONF_FACTOR[r.confidence] for r in fresh)
            live_val = sum(CONF_FACTOR[r.confidence] * min(1.0, max(0.0, r.congestion)) for r in fresh) / total
            best = max(fresh, key=lambda r: (CONFIDENCE_RANK[r.confidence], r.observed_at))
            fade = 1 - max(ahead, timedelta(0)) / LIVE_WINDOW
            weight = LIVE_WEIGHT_MAX * fade * CONF_FACTOR[best.confidence]
            congestion = weight * live_val + (1 - weight) * pred
            source = "live:" + "+".join(sorted({r.source for r in fresh}))
            updated = max(r.observed_at for r in fresh)
            detail = best.detail
            if best.confidence == "low":
                confidence = "low"
            elif weight >= STRONG_LIVE_WEIGHT:
                confidence = "high"
        elif self.live.feed_down("traffic") and ahead <= LIVE_WINDOW:
            confidence = "low"

        incident, slowdown, closed = self._incident(seg.id, enter_at)
        travel = models.congestion.travel_time_for_score(seg.id, congestion) * slowdown
        return SegmentCondition(
            segment_id=seg.id,
            enter_at=enter_at,
            travel_s=travel,
            congestion=congestion,
            predicted_congestion=pred,
            congestion_source=source,
            live_weight=weight,
            live_updated_at=updated,
            live_detail=detail,
            crash_risk=models.crash.get_crash_risk(seg.id, enter_at),
            incident=incident,
            incident_slowdown=slowdown,
            closed=closed,
            confidence=confidence,
        )

    def incident_end(self, inc: Incident) -> datetime:
        if inc.clears_at is not None:
            return inc.clears_at
        return max(inc.started_at + INCIDENT_DEFAULT, self.now + INCIDENT_MIN_REMAINING)

    def _incident(self, segment_id: str, at: datetime) -> tuple[Incident | None, float, bool]:
        worst_inc, slowdown = None, 1.0
        for inc in self.live.incidents_on.get(segment_id, ()):
            if not (inc.started_at <= max(at, self.now) < self.incident_end(inc)):
                continue
            if inc.kind == "closure":
                return inc, 1.0, True
            factor = INCIDENT_SLOWDOWN.get(inc.kind, INCIDENT_SLOWDOWN["other"])
            factor = min(MAX_INCIDENT_SLOWDOWN, factor + EXTRA_LANE_SLOWDOWN * max(0, inc.lanes_blocked - 1))
            if factor > slowdown:
                worst_inc, slowdown = inc, factor
        return worst_inc, slowdown, False

    # --- crossings ------------------------------------------------------------------------

    def crossing(self, c: CrossingInfo, arrive_at: datetime) -> CrossingCondition:
        train = self.provider.models.train
        now = self.now
        p_pred = train.get_block_probability(c.id, arrive_at)
        avg_min = train.get_avg_block_minutes(c.id, arrive_at)

        st = self.live.crossings.get(c.id)
        stale = st is not None and now - st.updated_at > CROSSING_STATUS_MAX_AGE
        if st is not None and not stale:
            conf: Confidence = "high" if st.sensor_up else "low"
            if st.blocked:
                clears = st.clears_at or now + timedelta(minutes=avg_min * 0.5)
                if arrive_at < clears:
                    return CrossingCondition(
                        c.id, arrive_at, 1.0, (clears - arrive_at).total_seconds(), True,
                        st.sensor_up, conf, st.source, st.updated_at,
                    )
            elif st.sensor_up and arrive_at - now <= CLEAR_TRUST:
                return CrossingCondition(c.id, arrive_at, 0.0, 0.0, True, True, "high", st.source, st.updated_at)

        conf = "medium"
        soon = arrive_at - now <= LIVE_WINDOW
        if st is not None and (stale or not st.sensor_up):
            conf = "low"
        elif soon and self.live.feed_down("trains"):
            conf = "low"
        return CrossingCondition(
            c.id, arrive_at, p_pred, p_pred * avg_min * 60 * 0.5, False,
            None if st is None else (st.sensor_up and not stale), conf, "history",
            None if st is None else st.updated_at,
        )

    # --- helpers --------------------------------------------------------------------------

    def without_live(self) -> "ConditionsView":
        """Same moment, predictions only: what we'd do if no live data existed."""
        return ConditionsView(self.provider, LiveState(now=self.now, feeds=self.live.feeds))

    @property
    def has_live(self) -> bool:
        return self.live.has_data

    @property
    def feeds_down(self) -> list[str]:
        return [n for n, f in self.live.feeds.items() if not f.ok]

    def freshness(self) -> dict:
        """How old the newest live data is, per source, plus which feeds are up."""

        def age(times) -> int | None:
            times = [x for x in times if x is not None]
            return None if not times else max(0, round((self.now - max(times)).total_seconds() / 60))

        readings = [r for rs in self.live.traffic.values() for r in rs]
        by_source: dict[str, list[datetime]] = defaultdict(list)
        for r in readings:
            by_source[r.source].append(r.observed_at)
        return {
            "history": "8-week replay per 15-min slot (synthetic until real history is loaded)",
            "live_rss_age_min": age(by_source.get("transtar_rss", [])),
            "cameras_age_min": age(by_source.get("camera", [])),
            "live_traffic_age_min": age([r.observed_at for r in readings]),
            "crossings_age_min": age([s.updated_at for s in self.live.crossings.values()]),
            "incidents_age_min": age([i.updated_at for i in self.live.incidents]),
            "feeds": {n: ("up" if f.ok else "down") for n, f in self.live.feeds.items()},
        }


class ConditionsProvider:
    def __init__(self, network: Network, models, sources=None, now: Callable[[], datetime] | None = None) -> None:
        self.network = network
        self.models = models
        self.sources = sources
        self._now = now

    @property
    def has_clock(self) -> bool:
        return self._now is not None

    def now(self) -> datetime:
        if self._now is None:
            raise RuntimeError("ConditionsProvider has no clock; pass now= to view()")
        return self._now()

    def view(self, now: datetime | None = None, live: bool = True) -> ConditionsView:
        now = now or self.now()
        return ConditionsView(self, self.collect(now) if live else LiveState(now=now))

    def collect(self, now: datetime) -> LiveState:
        """Pull every live source once. A source that raises is marked down, never fatal."""
        state = LiveState(now=now)
        if self.sources is None:
            return state
        feeds: dict[str, FeedStatus] = {}

        def pull(name: str, fn):
            try:
                items = list(fn(now))
            except Exception as e:  # any upstream failure -> fall back to predictions
                feeds[name] = FeedStatus(name, False, 0, f"{type(e).__name__}: {e}")
                return []
            feeds[name] = FeedStatus(name, True, len(items))
            return items

        statuses = pull("trains", self.sources.trains.crossing_status)
        traffic = pull("traffic", self.sources.live_traffic.current)
        incidents = pull("incidents", self.sources.incidents.active)

        by_seg: dict[str, list[LiveTraffic]] = defaultdict(list)
        for r in traffic:
            if r.segment_id in self.network.segments:
                by_seg[r.segment_id].append(r)
        crossings = {}
        for s in statuses:
            if s.crossing_id in self.network.crossings:
                prev = crossings.get(s.crossing_id)
                if prev is None or s.updated_at >= prev.updated_at:
                    crossings[s.crossing_id] = s
        return LiveState(
            now=now,
            traffic=dict(by_seg),
            # Unmatched incidents stay listed (for /live) but only matched ones affect routing.
            incidents=incidents,
            crossings=crossings,
            feeds=feeds,
        )
