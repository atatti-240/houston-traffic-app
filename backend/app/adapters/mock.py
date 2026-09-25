"""Mock DataSources backed by the deterministic synthetic world."""

from datetime import date, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.adapters.base import CameraSource, CrashSource, SpeedSource, TrainSource
from app.models import Camera
from app.seed.synthetic import CrashRecord, SpeedObservation, SyntheticWorld, TrainEvent


class MockSpeedSource(SpeedSource):
    def __init__(self, world: SyntheticWorld) -> None:
        self.world = world

    def observations(self, day: date) -> list[SpeedObservation]:
        return self.world.speed_observations(day)


class MockCrashSource(CrashSource):
    def __init__(self, world: SyntheticWorld) -> None:
        self.world = world

    def crashes(self, day: date) -> list[CrashRecord]:
        return self.world.crashes(day)


class MockTrainSource(TrainSource):
    """Synthetic trains, plus blockages injected by the demo (POST /demo/block-crossing)."""

    def __init__(self, world: SyntheticWorld) -> None:
        self.world = world
        self.injected: list[TrainEvent] = []

    def crossing_events(self, day: date) -> list[TrainEvent]:
        return self.world.train_events(day)

    def inject(self, crossing_id: str, start: datetime, minutes: float) -> TrainEvent:
        event = TrainEvent(crossing_id, start, start + timedelta(minutes=minutes))
        self.injected.append(event)
        return event

    def clear_injected(self) -> None:
        self.injected.clear()

    def active_blockages(self, now: datetime) -> list[TrainEvent]:
        # Only demo-injected blockages count as "live" so the demo stays predictable.
        return [e for e in self.injected if e.start <= now < e.end]


class MockCameraSource(CameraSource):
    def __init__(self, session_factory: sessionmaker[Session]) -> None:
        self.session_factory = session_factory

    def cameras(self) -> list[dict]:
        with self.session_factory() as s:
            return [
                {
                    "id": c.id,
                    "kind": c.kind,
                    "name": c.name,
                    "lat": c.lat,
                    "lng": c.lng,
                    "url": c.url,
                    "segment_id": c.segment_id,
                    "crossing_id": c.crossing_id,
                    "mock": True,
                }
                for c in s.scalars(select(Camera))
            ]
