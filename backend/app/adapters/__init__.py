"""Pick DataSource implementations from config."""

from dataclasses import dataclass

from sqlalchemy.orm import Session, sessionmaker

from app.adapters.base import (
    CameraSource,
    CrashSource,
    IncidentSource,
    LiveTrafficSource,
    SpeedSource,
    TrainSource,
)


@dataclass
class DataSources:
    speeds: SpeedSource
    crashes: CrashSource
    trains: TrainSource
    cameras: CameraSource
    live_traffic: LiveTrafficSource
    incidents: IncidentSource

    def clear_demo_live(self) -> None:
        """Drop everything the demo injected (blockages, sensor outages, traffic, incidents,
        downed feeds). No-op for real sources."""
        for src in (self.trains, self.live_traffic, self.incidents):
            for method in ("clear_injected", "clear"):
                fn = getattr(src, method, None)
                if fn:
                    fn()
                    break


def build_sources(kind: str, session_factory: sessionmaker[Session], seed: int = 42) -> DataSources:
    if kind == "mock":
        from app.adapters.mock import (
            MockCameraSource,
            MockCrashSource,
            MockIncidentSource,
            MockLiveTrafficSource,
            MockSpeedSource,
            MockTrainSource,
        )
        from app.seed.synthetic import SyntheticWorld

        world = SyntheticWorld(seed)
        return DataSources(
            speeds=MockSpeedSource(world),
            crashes=MockCrashSource(world),
            trains=MockTrainSource(world),
            cameras=MockCameraSource(session_factory),
            live_traffic=MockLiveTrafficSource(),
            incidents=MockIncidentSource(),
        )
    raise ValueError(f"Unknown DATA_SOURCE {kind!r}; only 'mock' is implemented")
