"""FastAPI entrypoint. On first boot it seeds the network and replays history automatically."""

import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func, select

from app.api import demo, network, planning
from app.config import settings
from app.db import SessionLocal, init_db
from app.models import RoadSegment, ScoreEntry
from app.services import Services

log = logging.getLogger("houston")


def bootstrap() -> Services:
    """Make sure the DB has a network and trained scores, then build the services."""
    from app.seed.network import seed_network

    init_db()
    with SessionLocal() as s:
        if not s.scalar(select(func.count()).select_from(RoadSegment)):
            log.warning("Empty database: seeding Houston network")
            seed_network(s)
        has_scores = bool(s.scalar(select(func.count()).select_from(ScoreEntry)))
    svc = Services(SessionLocal)
    if not has_scores:
        log.warning("No scores yet: replaying %s weeks of synthetic history", settings.history_weeks)
        svc.replay()
    return svc


async def _scheduler_loop(svc: Services, interval: float) -> None:
    while True:
        await asyncio.sleep(interval)
        try:
            await asyncio.to_thread(svc.tick)
        except Exception:  # keep the loop alive during a demo no matter what
            log.exception("scheduler tick failed")


def create_app(services: Services | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if services is None:
            app.state.services = bootstrap()
        task = None
        if settings.scheduler_interval_s > 0 and services is None:
            task = asyncio.create_task(_scheduler_loop(app.state.services, settings.scheduler_interval_s))
        yield
        if task:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    app = FastAPI(
        title="Houston Traffic API",
        version="0.1.0",
        description="Predicts congestion, crash risk and train crossing blockages to tell Houston "
        "commuters when to leave and which way to go.",
        lifespan=lifespan,
    )
    if services is not None:
        app.state.services = services
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health", tags=["meta"])
    def health() -> dict:
        return {"status": "ok"}

    app.include_router(network.router)
    app.include_router(planning.router)
    app.include_router(demo.router)
    return app


app = create_app()
