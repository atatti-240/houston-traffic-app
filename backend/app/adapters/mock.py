"""Mock DataSources backed by the deterministic synthetic world."""

from datetime import date, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.adapters.base import (
    CameraSource,
    CrashSource,
    FeedUnavailable,
    IncidentSource,
    LiveTrafficSource,
    SpeedSource,
    TrainSource,
)
from app.conditions.live import CrossingStatus, Incident, IncidentKind, LiveTraffic
from app.models import Camera
from app.seed.synthetic import CrashRecord, SpeedObservation, SyntheticWorld, TrainEvent


class _Switchable:
    """Lets the demo take a mock feed "down" to show the fallback to predictions."""

    name = "feed"
    down = False

    def _check(self) -> None:
        if self.down:
            raise FeedUnavailable(f"{self.name} feed is down (demo)")


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


class MockTrainSource(_Switchable, TrainSource):
    """Synthetic trains, plus blockages and sensor outages injected by the demo."""

    name = "trains"

    def __init__(self, world: SyntheticWorld) -> None:
        self.world = world
        self.injected: list[TrainEvent] = []
        self.sensor_down: set[str] = set()

    def crossing_events(self, day: date) -> list[TrainEvent]:
        return self.world.train_events(day)

    def inject(self, crossing_id: str, start: datetime, minutes: float) -> TrainEvent:
        event = TrainEvent(crossing_id, start, start + timedelta(minutes=minutes))
        self.injected.append(event)
        return event

    def set_sensor(self, crossing_id: str, up: bool) -> None:
        (self.sensor_down.discard if up else self.sensor_down.add)(crossing_id)

    def clear_injected(self) -> None:
        self.injected.clear()
        self.sensor_down.clear()
        self.down = False

    def active_blockages(self, now: datetime) -> list[TrainEvent]:
        # Only demo-injected blockages count as "live" so the demo stays predictable.
        self._check()
        return [e for e in self.injected if e.start <= now < e.end]

    def crossing_status(self, now: datetime) -> list[CrossingStatus]:
        blocked = {e.crossing_id: e for e in self.active_blockages(now)}
        ids = set(blocked) | self.sensor_down
        return [
            CrossingStatus(
                crossing_id=cid,
                blocked=cid in blocked,
                sensor_up=cid not in self.sensor_down,
                updated_at=now,
                source="demo",
                clears_at=blocked[cid].end if cid in blocked else None,
            )
            for cid in sorted(ids)
        ]


class MockLiveTrafficSource(_Switchable, LiveTrafficSource):
    """No live traffic unless the demo injects some (POST /demo/live-traffic)."""

    name = "traffic"

    def __init__(self) -> None:
        self.readings: dict[str, LiveTraffic] = {}

    def inject(self, reading: LiveTraffic) -> LiveTraffic:
        self.readings[reading.segment_id] = reading
        return reading

    def clear(self) -> None:
        self.readings.clear()
        self.down = False

    def current(self, now: datetime) -> list[LiveTraffic]:
        self._check()
        return [r for r in self.readings.values() if r.observed_at <= now]


class MockIncidentSource(_Switchable, IncidentSource):
    """No incidents unless the demo injects some (POST /demo/incident)."""

    name = "incidents"

    def __init__(self) -> None:
        self.items: dict[str, Incident] = {}
        self._n = 0

    def inject(
        self,
        segment_id: str | None,
        kind: IncidentKind,
        title: str,
        started_at: datetime,
        minutes: float | None,
        lanes_blocked: int = 1,
    ) -> Incident:
        self._n += 1
        inc = Incident(
            id=f"demo-{self._n}",
            title=title,
            kind=kind,
            segment_id=segment_id,
            started_at=started_at,
            source="demo",
            updated_at=started_at,
            clears_at=started_at + timedelta(minutes=minutes) if minutes else None,
            lanes_blocked=lanes_blocked,
        )
        self.items[inc.id] = inc
        return inc

    def clear(self) -> None:
        self.items.clear()
        self.down = False

    def active(self, now: datetime) -> list[Incident]:
        self._check()
        return [i for i in self.items.values() if i.started_at <= now and (i.clears_at is None or now < i.clears_at)]


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
