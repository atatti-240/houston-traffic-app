"""FastAPI entrypoint. On first boot it seeds the network and replays history automatically."""

import asyncio
import contextlib
import logging
import signal
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func, select

from app.api import causes, cv, demo, directions, geo, network, planning, plans, reports, shares, travel
from app.config import settings
from app.db import SessionLocal, init_db
from app.models import RoadSegment, ScoreEntry
from app.services import Services

log = logging.getLogger("houston")


def bootstrap() -> Services:
    """Make sure the DB has a network and trained scores, then build the services."""
    from app.seed.network import refresh_shapes, seed_network
    from app.seed.road_rules import refresh_road_rules

    init_db()
    with SessionLocal() as s:
        if not s.scalar(select(func.count()).select_from(RoadSegment)):
            log.warning("Empty database: seeding Houston network")
            seed_network(s)
        elif n := refresh_shapes(s):
            log.warning("Updated %s road shapes, crossings and cameras to the traced roads", n)
        if n := refresh_road_rules(s):
            log.warning("Updated speed limits and toll roads on %s segments", n)
        has_scores = bool(s.scalar(select(func.count()).select_from(ScoreEntry)))
    svc = Services(SessionLocal)
    if not has_scores:
        log.warning("No scores yet: replaying %s weeks of synthetic history", settings.history_weeks)
        svc.replay()
    return svc


def _on_exit_signal(fn) -> None:
    """Also call fn when the server is told to stop (Ctrl-C, SIGTERM, a --reload restart). Uvicorn
    then waits for open connections before shutting down, so endless responses like the camera
    video must end first."""
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            prev = signal.getsignal(sig)
            if not callable(prev):
                continue

            def handler(s, frame, prev=prev):
                fn()
                prev(s, frame)

            signal.signal(sig, handler)
        except ValueError:  # not the main thread: nothing to hook
            return


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
        svc = app.state.services
        task = None
        if settings.scheduler_interval_s > 0 and services is None:
            task = asyncio.create_task(_scheduler_loop(svc, settings.scheduler_interval_s))
        if svc.cv is not None and services is None:
            # A camera-confirmed incident starting or clearing re-plans watched trips right away.
            svc.cv.on_incidents_changed = lambda: svc.tick(replan_now=True)
            svc.cv.start()
            cv.CLOSING.clear()
            _on_exit_signal(cv.CLOSING.set)
        yield
        if svc.cv is not None:
            svc.cv.stop()
        if task:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    app = FastAPI(
        title="BlindSpot API",
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
    app.include_router(plans.router)
    app.include_router(shares.router)
    app.include_router(causes.router)
    app.include_router(demo.router)
    app.include_router(geo.router)
    app.include_router(cv.router)
    app.include_router(reports.router)
    app.include_router(directions.router)
    app.include_router(travel.router)
    return app


app = create_app()
