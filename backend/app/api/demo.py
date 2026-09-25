"""Demo controls: simulated clock, live train blockages, history replay, reset."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete

from app.api.deps import get_services, resolve_time
from app.api.planning import notification_json
from app.api.schemas import AdvanceClockRequest, BlockCrossingRequest
from app.config import settings
from app.models import Notification, Trip, TripState
from app.services import Services

router = APIRouter(tags=["demo"])


def _clock_json(svc: Services) -> dict:
    now = svc.clock.now()
    return {"now": now, "weekday": now.strftime("%A"), "speed": svc.clock.speed}


@router.get("/clock")
def get_clock(svc: Services = Depends(get_services)):
    return _clock_json(svc)


@router.post("/demo/advance-clock")
def advance_clock(req: AdvanceClockRequest, svc: Services = Depends(get_services)):
    """Jump simulated time (by `minutes` or `to` a datetime), then run the trip scheduler."""
    if req.to is not None:
        svc.clock.set(req.to.replace(tzinfo=None))
    elif req.minutes is not None:
        svc.clock.advance(req.minutes)
    sent = svc.tick()
    return {**_clock_json(svc), "notifications": [notification_json(n) for n in sent]}


@router.post("/demo/tick")
def tick(svc: Services = Depends(get_services)):
    return {**_clock_json(svc), "notifications": [notification_json(n) for n in svc.tick()]}


@router.post("/demo/block-crossing")
def block_crossing(req: BlockCrossingRequest, svc: Services = Depends(get_services)):
    """Simulate a train blocking a crossing right now (or from `start`) for `minutes`."""
    if req.crossing_id not in svc.network.crossings:
        raise HTTPException(404, f"unknown crossing {req.crossing_id!r}")
    inject = getattr(svc.sources.trains, "inject", None)
    if inject is None:
        raise HTTPException(400, "live blockage injection needs the mock train source")
    start = resolve_time(svc, req.start)
    e = inject(req.crossing_id, start, req.minutes)
    sent = svc.tick()
    return {
        "crossing_id": e.crossing_id,
        "start": e.start,
        "end": e.end,
        "notifications": [notification_json(n) for n in sent],
    }


@router.post("/demo/clear-blockages")
def clear_blockages(svc: Services = Depends(get_services)):
    clear = getattr(svc.sources.trains, "clear_injected", None)
    if clear:
        clear()
    return {"ok": True}


@router.post("/demo/replay")
def replay(days: int | None = None, svc: Services = Depends(get_services)):
    """Re-run the history replay (ending at the simulated today) through all models."""
    n = svc.replay(days)
    return {"replayed_days": n, "scores": len(svc.models.store)}


@router.post("/demo/reset")
def reset(svc: Services = Depends(get_services)):
    """Back to Monday 7:15 AM with no trips, notifications or live blockages."""
    with svc.session_factory() as s:
        for model in (Notification, TripState, Trip):
            s.execute(delete(model))
        s.commit()
    clear_blockages(svc)
    svc.clock.set(settings.sim_start)
    return _clock_json(svc)
