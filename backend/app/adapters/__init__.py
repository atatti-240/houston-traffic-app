"""Pick DataSource implementations from config."""

from dataclasses import dataclass

from sqlalchemy.orm import Session, sessionmaker

from app.adapters.base import CameraSource, CrashSource, SpeedSource, TrainSource


@dataclass
class DataSources:
    speeds: SpeedSource
    crashes: CrashSource
    trains: TrainSource
    cameras: CameraSource


def build_sources(kind: str, session_factory: sessionmaker[Session], seed: int = 42) -> DataSources:
    if kind == "mock":
        from app.adapters.mock import MockCameraSource, MockCrashSource, MockSpeedSource, MockTrainSource
        from app.seed.synthetic import SyntheticWorld

        world = SyntheticWorld(seed)
        return DataSources(
            speeds=MockSpeedSource(world),
            crashes=MockCrashSource(world),
            trains=MockTrainSource(world),
            cameras=MockCameraSource(session_factory),
        )
    raise ValueError(f"Unknown DATA_SOURCE {kind!r}; only 'mock' is implemented")
