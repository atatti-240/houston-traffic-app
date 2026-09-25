"""Train blockage: per (crossing, day-of-week x 15-min slot).

value = EMA of "was the crossing blocked at any point in this slot" (0/1) -> probability.
aux   = EMA of the blockage length in minutes, only updated on days it was blocked.
Expected delay = p_block * avg_minutes * 0.5 (on average you arrive halfway through).
A live blockage (actually blocked right now) overrides the prediction.
"""

from datetime import date, datetime, time, timedelta

from app.graph import Network
from app.scoring.store import ScoreStore
from app.seed.synthetic import TrainEvent
from app.timebuckets import SLOT_MINUTES, SLOTS_PER_DAY, fine_bucket, fine_bucket_key

MODEL = "train"
DEFAULT_BLOCK_MINUTES = 8.0


class TrainBlockModel:
    def __init__(self, store: ScoreStore, network: Network, alpha: float = 0.2) -> None:
        self.store = store
        self.network = network
        self.alpha = alpha

    def update_from_events(self, day: date, events: list[TrainEvent]) -> None:
        dow = day.weekday()
        midnight = datetime.combine(day, time())
        by_crossing: dict[str, list[TrainEvent]] = {}
        for e in events:
            by_crossing.setdefault(e.crossing_id, []).append(e)

        for cid in self.network.crossings:
            evs = by_crossing.get(cid, [])
            for slot in range(SLOTS_PER_DAY):
                s_start = midnight + timedelta(minutes=slot * SLOT_MINUTES)
                s_end = s_start + timedelta(minutes=SLOT_MINUTES)
                overlapping = [e for e in evs if e.start < s_end and e.end > s_start]
                bucket = fine_bucket_key(dow, slot)
                self.store.ema(MODEL, cid, bucket, 1.0 if overlapping else 0.0, self.alpha)
                if overlapping:
                    longest = max(e.minutes for e in overlapping)
                    self.store.ema_aux(MODEL, cid, bucket, longest, self.alpha)

    def get_block_probability(self, crossing_id: str, at: datetime) -> float:
        entry = self.store.get(MODEL, crossing_id, fine_bucket(at))
        return entry.value if entry else 0.0

    def get_avg_block_minutes(self, crossing_id: str, at: datetime) -> float:
        entry = self.store.get(MODEL, crossing_id, fine_bucket(at))
        return entry.aux if entry and entry.aux is not None else DEFAULT_BLOCK_MINUTES

    def get_expected_delay(
        self, crossing_id: str, at: datetime, live: list[TrainEvent] | None = None
    ) -> float:
        """Expected seconds lost at the crossing when arriving at `at`."""
        for e in live or ():
            if e.crossing_id == crossing_id and e.start <= at < e.end:
                return (e.end - at).total_seconds()
        p = self.get_block_probability(crossing_id, at)
        return p * self.get_avg_block_minutes(crossing_id, at) * 60 * 0.5
