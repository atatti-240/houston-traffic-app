"""Simulated clock. Everything that needs "now" reads it from here so the demo can jump time."""

from datetime import datetime, timedelta

from app.config import settings


class SimClock:
    def __init__(self, start: datetime | None = None) -> None:
        self._now = start or settings.sim_start

    def now(self) -> datetime:
        return self._now

    def set(self, when: datetime) -> datetime:
        self._now = when
        return self._now

    def advance(self, minutes: float) -> datetime:
        self._now += timedelta(minutes=minutes)
        return self._now


clock = SimClock()
