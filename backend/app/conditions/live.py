"""Live data records the road-conditions layer understands.

Real adapters (Train Watch, TranStar RSS, TranStar cameras + YOLO) produce these after
matching their raw data to graph segments/crossings. The router never sees the raw feeds.
"""

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

Confidence = Literal["high", "medium", "low"]

CONFIDENCE_RANK: dict[str, int] = {"low": 0, "medium": 1, "high": 2}


def worst(*levels: Confidence) -> Confidence:
    return min(levels, key=CONFIDENCE_RANK.__getitem__) if levels else "medium"


@dataclass(frozen=True)
class LiveTraffic:
    """A live congestion reading for one graph segment.

    congestion uses the model's scale: 0 = free flow, 1 = stopped. Adapters convert their
    raw signal (TranStar live travel time vs free flow, camera vehicle count vs that camera's
    own baseline) into this scale.
    """

    segment_id: str
    congestion: float
    source: str  # "transtar_rss", "camera", "demo", ...
    observed_at: datetime
    confidence: Confidence = "high"
    detail: str = ""  # human text, e.g. "29 vehicles vs 18 usual"


IncidentKind = Literal["crash", "stall", "roadwork", "closure", "hazard", "other"]


@dataclass(frozen=True)
class Incident:
    """An incident reported on (or near) the road network.

    segment_id is None when the adapter could not match it to a graph segment; those are
    still listed on /live but never affect routing.
    """

    id: str
    title: str
    kind: IncidentKind
    segment_id: str | None
    started_at: datetime
    source: str  # "transtar_rss", "demo", ...
    updated_at: datetime
    clears_at: datetime | None = None
    lanes_blocked: int = 1
    detail: str = ""


@dataclass(frozen=True)
class CrossingStatus:
    """Live state of one rail crossing (Train Watch style)."""

    crossing_id: str
    blocked: bool
    sensor_up: bool
    updated_at: datetime
    source: str  # "trainwatch", "demo", ...
    clears_at: datetime | None = None  # when a blocked crossing is expected to clear


@dataclass(frozen=True)
class FeedStatus:
    name: str
    ok: bool
    records: int = 0
    error: str | None = None
