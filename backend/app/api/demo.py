"""Demo controls: simulated clock, fake live data (trains, traffic, incidents, sensors,
feed outages), history replay, reset. They need the mock data sources."""

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete

from app.api.deps import get_services, resolve_time
from app.api.planning import notification_json
from app.api.schemas import (
    AdvanceClockRequest,
    BlockCrossingRequest,
    CrossingSensorRequest,
    FeedRequest,
    IncidentRequest,
    LiveTrafficRequest,
    incident_json,
)
from app.conditions.live import LiveTraffic
from app.config import settings
from app.models import Notification, SavedPlan, Trip, TripState
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
        svc.clock.set(resolve_time(svc, req.to))
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
    sent = svc.tick(replan_now=True)
    return {
        "crossing_id": e.crossing_id,
        "start": e.start,
        "end": e.end,
        "notifications": [notification_json(n) for n in sent],
    }


def _mock(source, method: str):
    fn = getattr(source, method, None)
    if fn is None:
        raise HTTPException(400, f"{method} needs the mock data sources (DATA_SOURCE=mock)")
    return fn


def _notes(svc: Services) -> list[dict]:
    """Live data changed: re-check trips and re-plan watched plans right away."""
    return [notification_json(n) for n in svc.tick(replan_now=True)]


@router.post("/demo/live-traffic")
def live_traffic(req: LiveTrafficRequest, svc: Services = Depends(get_services)):
    """Pretend a camera / TranStar reading just came in for these segments (0 free .. 1 stopped).
    It overrides the prediction for about 30 minutes, fading out as it gets further ahead."""
    unknown = [sid for sid in req.segment_ids if sid not in svc.network.segments]
    if unknown:
        raise HTTPException(404, f"unknown segments {unknown}")
    inject = _mock(svc.sources.live_traffic, "inject")
    at = svc.clock.now() - timedelta(minutes=req.minutes_ago)
    for sid in req.segment_ids:
        inject(LiveTraffic(sid, req.congestion, req.source, at, req.confidence, req.detail))
    return {"segment_ids": req.segment_ids, "observed_at": at, "notifications": _notes(svc)}


@router.post("/demo/incident")
def incident(req: IncidentRequest, svc: Services = Depends(get_services)):
    """Report a crash / stall / roadwork / closure on a segment. Closures remove the road."""
    seg = svc.network.segments.get(req.segment_id)
    if seg is None:
        raise HTTPException(404, f"unknown segment {req.segment_id!r}")
    inject = _mock(svc.sources.incidents, "inject")
    start = resolve_time(svc, req.start)
    title = req.title or f"{seg.name} - {req.kind.capitalize()}"
    inc = inject(req.segment_id, req.kind, title, start, req.minutes, req.lanes_blocked)
    return {"incident": incident_json(inc), "notifications": _notes(svc)}


@router.post("/demo/crossing-sensor")
def crossing_sensor(req: CrossingSensorRequest, svc: Services = Depends(get_services)):
    """Take a crossing's sensor down (its data is still used, but at low confidence) or back up."""
    if req.crossing_id not in svc.network.crossings:
        raise HTTPException(404, f"unknown crossing {req.crossing_id!r}")
    _mock(svc.sources.trains, "set_sensor")(req.crossing_id, req.up)
    return {"crossing_id": req.crossing_id, "sensor": "UP" if req.up else "DOWN", "notifications": _notes(svc)}


@router.post("/demo/feed")
def feed(req: FeedRequest, svc: Services = Depends(get_services)):
    """Take a whole live feed down (routing falls back to predictions) or back up."""
    src = {"trains": svc.sources.trains, "traffic": svc.sources.live_traffic, "incidents": svc.sources.incidents}[
        req.feed
    ]
    if not hasattr(src, "down"):
        raise HTTPException(400, "feed switching needs the mock data sources (DATA_SOURCE=mock)")
    src.down = not req.up
    return {"feed": req.feed, "up": req.up, "notifications": _notes(svc)}


@router.post("/demo/clear-live")
def clear_live(svc: Services = Depends(get_services)):
    """Drop every injected blockage, sensor outage, live reading and incident; feeds back up."""
    svc.sources.clear_demo_live()
    return {"ok": True, "notifications": _notes(svc)}


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
    """Back to Monday 7:15 AM with no trips, plans, notifications or live data."""
    with svc.session_factory() as s:
        for model in (Notification, TripState, Trip, SavedPlan):
            s.execute(delete(model))
        s.commit()
    svc.sources.clear_demo_live()
    svc.clock.set(settings.sim_start)
    return _clock_json(svc)
