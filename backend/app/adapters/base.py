"""DataSource interfaces. Each maps to a real feed (see README "How real data plugs in").

Implementations are chosen by settings.data_source; only "mock" exists today.

Two kinds of source:
- history sources (speeds, crashes, crossing events) train the prediction models;
- live sources (crossing status, live traffic, incidents) feed the road-conditions layer,
  which lets them override predictions for the next ~30 minutes.

Live methods are called once per routing request, so real adapters must be cheap: cache
the upstream response internally (e.g. refresh at most once a minute) and raise on failure.
The conditions layer catches the error, marks the feed down and falls back to predictions.
"""

from abc import ABC, abstractmethod
from datetime import date, datetime

from app.conditions.live import CrossingStatus, Incident, LiveTraffic
from app.seed.synthetic import CrashRecord, SpeedObservation, TrainEvent


class FeedUnavailable(RuntimeError):
    """Raised by a live source when its upstream is down or returns garbage."""


class SpeedSource(ABC):
    """Per-segment speeds by 15-min slot (history). Real: TranStar historical travel times."""

    @abstractmethod
    def observations(self, day: date) -> list[SpeedObservation]: ...


class CrashSource(ABC):
    """Crash records with segment + timestamp (history). Real: TxDOT CRIS, Vision Zero HIN prior."""

    @abstractmethod
    def crashes(self, day: date) -> list[CrashRecord]: ...


class TrainSource(ABC):
    """Crossing blockages. Real: Train Watch (ArcGIS), crossing sensors."""

    @abstractmethod
    def crossing_events(self, day: date) -> list[TrainEvent]:
        """History: blockage events on a past day (trains the train model)."""

    @abstractmethod
    def active_blockages(self, now: datetime) -> list[TrainEvent]:
        """Crossings blocked right now."""

    def crossing_status(self, now: datetime) -> list[CrossingStatus]:
        """Live status per crossing, including sensor health.

        Default: every active blockage as a blocked crossing with a working sensor.
        Real adapters should return every crossing they know about (blocked or clear) so
        "sensor down" can be reported even when nothing is blocked.
        """
        return [
            CrossingStatus(e.crossing_id, True, True, e.start, "trainwatch", clears_at=e.end)
            for e in self.active_blockages(now)
        ]


class LiveTrafficSource(ABC):
    """Live congestion per graph segment. Real: TranStar RSS live travel times, cameras + YOLO."""

    @abstractmethod
    def current(self, now: datetime) -> list[LiveTraffic]: ...


class IncidentSource(ABC):
    """Active incidents and closures. Real: TranStar RSS incidents / lane closures."""

    @abstractmethod
    def active(self, now: datetime) -> list[Incident]: ...


class CameraSource(ABC):
    """Camera catalog. Real: TranStar CCTV list + train crossing cams."""

    @abstractmethod
    def cameras(self) -> list[dict]: ...
