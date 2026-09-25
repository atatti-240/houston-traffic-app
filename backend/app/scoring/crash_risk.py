"""Crash risk: per (segment, weekday|weekend x hour), EMA of crashes per mile.

Crashes are sparse, so each daily observation pools both directions of the road and the
neighbouring hours (h-1..h+1), and short segments count as at least MIN_POOL_MILES so one
fender-bender on a one-mile street doesn't make it look like the West Loop. Risk is squashed into [0, 1] with 1 - exp(-rate / scale).
"""

import math
from collections import Counter
from datetime import date, datetime

from app.graph import Network
from app.scoring.store import ScoreStore
from app.seed.synthetic import CrashRecord
from app.timebuckets import crash_bucket, crash_bucket_key

MODEL = "crash"
PRIOR_RATE = 0.002  # crashes / mile / hour before we have any history
RATE_SCALE = 0.015  # rate at which risk reaches ~63%
MIN_POOL_MILES = 1.5


class CrashRiskModel:
    def __init__(self, store: ScoreStore, network: Network, alpha: float = 0.1) -> None:
        self.store = store
        self.network = network
        self.alpha = alpha

    def update_from_crashes(self, day: date, crashes: list[CrashRecord]) -> None:
        weekend = day.weekday() >= 5
        counts: Counter[tuple[str, int]] = Counter((c.segment_id, c.at.hour) for c in crashes)
        for seg in self.network.segments.values():
            miles = max(seg.length_miles, MIN_POOL_MILES)
            for hour in range(24):
                hours = [(hour + d) % 24 for d in (-1, 0, 1)]
                n = sum(counts[(sid, h)] for sid in (seg.id, seg.reverse_id) for h in hours)
                rate = n / (miles * 2 * len(hours))
                self.store.ema(MODEL, seg.id, crash_bucket_key(weekend, hour), rate, self.alpha, PRIOR_RATE)

    def get_rate(self, segment_id: str, at: datetime) -> float:
        entry = self.store.get(MODEL, segment_id, crash_bucket(at))
        return entry.value if entry else PRIOR_RATE

    def get_crash_risk(self, segment_id: str, at: datetime) -> float:
        return 1 - math.exp(-self.get_rate(segment_id, at) / RATE_SCALE)

    def top_risky(self, at: datetime, n: int = 10) -> list[tuple[str, float]]:
        scored = [(sid, self.get_crash_risk(sid, at)) for sid in self.network.segments]
        return sorted(scored, key=lambda x: x[1], reverse=True)[:n]
