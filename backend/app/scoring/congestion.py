"""Congestion Score: per (segment, day-of-week x 15-min slot), EMA of the daily congestion ratio."""

from datetime import date, datetime

from app.graph import Network
from app.scoring.store import ScoreStore
from app.seed.synthetic import SpeedObservation
from app.timebuckets import fine_bucket, fine_bucket_key

MODEL = "congestion"
DEFAULT_SCORE = 0.1  # used for buckets with no history yet
# At score 1.0 a segment moves at 15% of free-flow speed.
SLOWDOWN = 0.85


def congestion_ratio(observed_mph: float, free_flow_mph: float) -> float:
    return min(1.0, max(0.0, 1.0 - observed_mph / free_flow_mph))


class CongestionModel:
    def __init__(self, store: ScoreStore, network: Network, alpha: float = 0.2) -> None:
        self.store = store
        self.network = network
        self.alpha = alpha

    def update_from_observations(self, day: date, observations: list[SpeedObservation]) -> None:
        dow = day.weekday()
        for obs in observations:
            seg = self.network.segments.get(obs.segment_id)
            if seg is None:
                continue
            ratio = congestion_ratio(obs.speed_mph, seg.free_flow_mph)
            self.store.ema(MODEL, obs.segment_id, fine_bucket_key(dow, obs.slot), ratio, self.alpha)

    def get_score(self, segment_id: str, at: datetime) -> float:
        entry = self.store.get(MODEL, segment_id, fine_bucket(at))
        return entry.value if entry else DEFAULT_SCORE

    def get_segment_travel_time(self, segment_id: str, at: datetime) -> float:
        """Predicted seconds to traverse the segment if you enter it at `at`."""
        seg = self.network.segments[segment_id]
        return seg.free_flow_seconds / (1 - SLOWDOWN * self.get_score(segment_id, at))
