"""Wires the app together: network + models + router + scheduler, sharing one clock."""

from sqlalchemy.orm import Session, sessionmaker

from app.adapters import DataSources, build_sources
from app.conditions.provider import ConditionsProvider
from app.clock import SimClock
from app.config import settings
from app.graph import Network, load_network
from app.notifications.scheduler import TripScheduler
from app.notifications.service import NotificationService, build_notifier
from app.routing.router import Router
from app.scoring import Models, build_models, replay_history
from app.scoring.store import ScoreStore


class Services:
    def __init__(
        self,
        session_factory: sessionmaker[Session],
        clock: SimClock | None = None,
        sources: DataSources | None = None,
        notifier: NotificationService | None = None,
    ) -> None:
        self.session_factory = session_factory
        self.clock = clock or SimClock(settings.sim_start, settings.clock_speed)
        self.sources = sources or build_sources(settings.data_source, session_factory, settings.synthetic_seed)
        self.notifier = notifier or build_notifier(settings.notification_channel)
        self.reload()

    def reload(self) -> None:
        """(Re)load the network and scores from the DB."""
        with self.session_factory() as s:
            self.network: Network = load_network(s)
            models = build_models(self.network, ScoreStore().load(s))
        self._install(models)

    def _install(self, models: Models) -> None:
        # Build the new router/scheduler first, then swap: requests and scheduler ticks
        # running meanwhile keep using the old, complete set of scores.
        conditions = ConditionsProvider(self.network, models, self.sources, self.clock.now)
        router = Router(self.network, models, conditions)
        scheduler = TripScheduler(self.session_factory, router, self.notifier)
        self.models, self.router, self.scheduler = models, router, scheduler

    def replay(self, days: int | None = None) -> int:
        """Retrain from scratch on `days` of history into a fresh store, then swap it in."""
        days = days or settings.history_weeks * 7
        models = build_models(self.network)
        replay_history(models, self.sources, self.clock.now().date(), days)
        with self.session_factory() as s:
            models.store.save(s)
        self._install(models)
        return days

    def tick(self):
        return self.scheduler.tick(self.clock.now())
