"""Scoring models + history replay."""

from dataclasses import dataclass
from datetime import date, timedelta

from app.adapters import DataSources
from app.config import settings
from app.graph import Network
from app.scoring.congestion import CongestionModel
from app.scoring.crash_risk import CrashRiskModel
from app.scoring.store import ScoreStore
from app.scoring.train_block import TrainBlockModel


@dataclass
class Models:
    store: ScoreStore
    congestion: CongestionModel
    crash: CrashRiskModel
    train: TrainBlockModel


def build_models(network: Network, store: ScoreStore | None = None) -> Models:
    store = store or ScoreStore()
    return Models(
        store=store,
        congestion=CongestionModel(store, network, settings.congestion_alpha),
        crash=CrashRiskModel(store, network, settings.crash_alpha),
        train=TrainBlockModel(store, network, settings.train_alpha),
    )


def replay_history(models: Models, sources: DataSources, end: date, days: int) -> None:
    """Feed `days` of history (oldest first, ending the day before `end`) through all models."""
    for offset in range(days, 0, -1):
        day = end - timedelta(days=offset)
        models.congestion.update_from_observations(day, sources.speeds.observations(day))
        models.crash.update_from_crashes(day, sources.crashes.crashes(day))
        models.train.update_from_events(day, sources.trains.crossing_events(day))
