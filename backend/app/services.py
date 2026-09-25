"""Wires the app together: network + models + router + scheduler, sharing one clock."""

from sqlalchemy.orm import Session, sessionmaker

from app.adapters import DataSources, build_sources
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
        """(Re)load the network and scores from the DB, e.g. after a replay."""
        with self.session_factory() as s:
            self.network: Network = load_network(s)
            self.models: Models = build_models(self.network, ScoreStore().load(s))
        self.router = Router(self.network, self.models, lambda: self.sources.trains.active_blockages(self.clock.now()))
        self.scheduler = TripScheduler(self.session_factory, self.router, self.notifier)

    def replay(self, days: int | None = None) -> int:
        days = days or settings.history_weeks * 7
        self.models.store.clear()
        replay_history(self.models, self.sources, self.clock.now().date(), days)
        with self.session_factory() as s:
            self.models.store.save(s)
        return days

    def tick(self):
        return self.scheduler.tick(self.clock.now())
