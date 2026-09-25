"""Simulated clock. Everything that needs "now" reads it from here so the demo can jump time.

The clock runs forward at `speed` x real time from wherever it was last set (speed=0 freezes
it, which is what tests use).
"""

import time
from datetime import datetime, timedelta

from app.config import settings


class SimClock:
    def __init__(self, start: datetime | None = None, speed: float = 1.0) -> None:
        self.speed = speed
        self._anchor_sim = start or settings.sim_start
        self._anchor_real = time.monotonic()

    def now(self) -> datetime:
        elapsed = (time.monotonic() - self._anchor_real) * self.speed
        return (self._anchor_sim + timedelta(seconds=elapsed)).replace(microsecond=0)

    def set(self, when: datetime) -> datetime:
        self._anchor_sim = when
        self._anchor_real = time.monotonic()
        return self.now()

    def advance(self, minutes: float) -> datetime:
        return self.set(self.now() + timedelta(minutes=minutes))
