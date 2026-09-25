"""Read-only map data: places, segments, scores, crossings, cameras."""

from datetime import datetime

from fastapi import APIRouter, Depends

from app.api.deps import get_services, resolve_time
from app.services import Services

router = APIRouter(tags=["map"])


@router.get("/places")
def places(svc: Services = Depends(get_services)):
    return [{"id": n.id, "name": n.name, "lat": n.lat, "lng": n.lng} for n in svc.network.places()]


@router.get("/segments")
def segments(svc: Services = Depends(get_services)):
    return [
        {
            "id": s.id,
            "name": s.name,
            "highway": s.highway,
            "road_class": s.road_class,
            "direction": s.direction,
            "from_node": s.from_node,
            "to_node": s.to_node,
            "miles": round(s.length_miles, 2),
            "free_flow_mph": s.free_flow_mph,
            "geometry": [list(p) for p in s.geometry],
        }
        for s in svc.network.segments.values()
    ]


@router.get("/scores/congestion")
def congestion_scores(at: datetime | None = None, svc: Services = Depends(get_services)):
    t = resolve_time(svc, at)
    return {
        "at": t,
        "scores": {sid: round(svc.models.congestion.get_score(sid, t), 3) for sid in svc.network.segments},
    }


@router.get("/scores/crash-risk")
def crash_scores(at: datetime | None = None, svc: Services = Depends(get_services)):
    t = resolve_time(svc, at)
    return {
        "at": t,
        "scores": {sid: round(svc.models.crash.get_crash_risk(sid, t), 3) for sid in svc.network.segments},
    }


@router.get("/crossings")
def crossings(at: datetime | None = None, svc: Services = Depends(get_services)):
    t = resolve_time(svc, at)
    live = svc.sources.trains.active_blockages(svc.clock.now())
    out = []
    for c in svc.network.crossings.values():
        active = next((e for e in live if e.crossing_id == c.id and e.start <= t < e.end), None)
        out.append(
            {
                "id": c.id,
                "name": c.name,
                "lat": c.lat,
                "lng": c.lng,
                "rail_line": c.rail_line,
                "segment_ids": list(c.segment_ids),
                "block_probability": 1.0 if active else round(svc.models.train.get_block_probability(c.id, t), 3),
                "expected_delay_min": round(svc.models.train.get_expected_delay(c.id, t, live) / 60, 1),
                "live_blocked_until": active.end if active else None,
            }
        )
    return {"at": t, "crossings": out}


@router.get("/cameras")
def cameras(svc: Services = Depends(get_services)):
    return svc.sources.cameras.cameras()
