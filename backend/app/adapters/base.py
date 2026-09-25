"""DataSource interfaces. Each maps to a real feed (see README "How real data plugs in").

Implementations are chosen by settings.data_source; only "mock" exists today.
"""

from abc import ABC, abstractmethod
from datetime import date, datetime

from app.seed.synthetic import CrashRecord, SpeedObservation, TrainEvent


class SpeedSource(ABC):
    """Per-segment speeds by 15-min slot. Real: TranStar speeds / Bluetooth AVI travel times."""

    @abstractmethod
    def observations(self, day: date) -> list[SpeedObservation]: ...


class CrashSource(ABC):
    """Crash records with segment + timestamp. Real: TranStar incidents, TxDOT CRIS history."""

    @abstractmethod
    def crashes(self, day: date) -> list[CrashRecord]: ...


class TrainSource(ABC):
    """Crossing blockage events. Real: TrainWatch / crossing sensors / train position feeds."""

    @abstractmethod
    def crossing_events(self, day: date) -> list[TrainEvent]: ...

    @abstractmethod
    def active_blockages(self, now: datetime) -> list[TrainEvent]:
        """Crossings blocked right now (live override for predictions)."""


class CameraSource(ABC):
    """Camera catalog. Real: TranStar CCTV list + train crossing cams."""

    @abstractmethod
    def cameras(self) -> list[dict]: ...
