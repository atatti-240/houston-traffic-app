"""Why traffic is slow: slowdowns with their causes, a road's detail, traffic alerts, watches."""

import math

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select

from app.api.deps import get_services
from app.causes import CausesEngine, Slowdown, fmt
from app.conditions.provider import ConditionsView
from app.graph import Network
from app.models import SlowdownWatch
from app.services import Services
from app.timeutil import iso

router = APIRouter(tags=["causes"])

# Incident kind -> alert group (the Alerts screen's filters)
ALERT_GROUP = {
    "crash": "incident",
    "stall": "incident",
    "hazard": "incident",
    "other": "incident",
    "roadwork": "roadwork",
    "lane_closure": "roadwork",
    "closure": "roadwork",
    "event": "event",
    "weather": "weather",
}
LOOKING = {"N": "north", "NE": "northeast", "E": "east", "SE": "southeast", "S": "south", "SW": "southwest",
           "W": "west", "NW": "northwest"}


def cause_json(c) -> dict:
    return {
        "kind": c.kind,
        "label": c.label,
        "pct": c.pct,
        "minutes": round(c.seconds / 60, 1),
        "title": c.title,
        "detail": c.detail,
        "started_at": iso(c.started_at),
        "source": c.source,
    }


def slowdown_json(s: Slowdown) -> dict:
    main = s.main if s.causes else None
    return {
        "id": s.id,
        "road": s.road,
        "place": s.place,
        "miles": round(s.segment.length_miles, 1),
        "road_class": s.segment.road_class,
        "level": s.level,
        "closed": s.closed,
        "delay_min": s.delay_min,
        "speed_mph": round(s.speed_mph),
        "free_flow_mph": round(s.free_flow_mph),
        "usual_mph": round(s.usual_mph),
        "lat": s.lat,
        "lng": s.lng,
        "highlight": s.highlight,
        "kind": main.kind if main else None,
        "label": main.label if main else None,
        "title": main.title if main else "Flowing normally",
        "detail": main.detail if main else "",
        "started_at": iso(main.started_at) if main else None,
        "causes": [cause_json(c) for c in s.causes],
        "geometry": [list(p) for p in s.segment.geometry],
    }


@router.get("/slowdowns")
def slowdowns(svc: Services = Depends(get_services)):
    """Every slowdown right now, worst first, each with what's causing it. `highlight` marks
    the ones worth an icon on the map (anything unusual, plus the worst rush-hour spots)."""
    engine = CausesEngine(svc.router)
    items = engine.slowdowns()
    counts: dict[str, int] = {}
    for s in items:
        counts[s.main.kind] = counts.get(s.main.kind, 0) + 1
    return {
        "generated_at": iso(engine.now),
        "count": len(items),
        "counts_by_kind": counts,
        "items": [slowdown_json(s) for s in items],
    }


def _watch(svc: Services, segment_id: str) -> SlowdownWatch | None:
    with svc.session_factory() as s:
        return s.scalar(
            select(SlowdownWatch).where(SlowdownWatch.segment_id == segment_id, ~SlowdownWatch.done)
        )


def _segment(svc: Services, segment_id: str):
    seg = svc.network.segments.get(segment_id)
    if seg is None:
        raise HTTPException(404, f"unknown road segment {segment_id!r}")
    return seg


@router.get("/slowdowns/{segment_id}")
def slowdown_detail(segment_id: str, svc: Services = Depends(get_services)):
    """One road: status, delay, speed, what's causing it (share of delay) and its speed over
    the last 2 hours. Works for any segment, slow or not."""
    seg = _segment(svc, segment_id)
    engine = CausesEngine(svc.router)
    s = engine.analyze(seg)
    history = engine.history(seg)
    markers = []
    for c in s.causes:
        if c.started_at and history and history[0][0] <= c.started_at <= engine.now:
            markers.append({"t": iso(c.started_at), "label": f"{fmt(c.started_at).lower().replace(' ', '')} {c.label.lower()}"})
    return {
        **slowdown_json(s),
        "is_slowdown": s.is_slowdown,
        "history": {
            "points": [{"t": iso(t), "mph": round(mph, 1)} for t, mph in history],
            "usual_mph": round(s.usual_mph),
            "free_flow_mph": round(s.free_flow_mph),
            "markers": markers,
        },
        "watching": _watch(svc, segment_id) is not None,
    }


@router.post("/slowdowns/{segment_id}/watch", status_code=201)
def watch(segment_id: str, device_id: str | None = None, svc: Services = Depends(get_services)):
    """Notify me when this road clears (a 'cleared' alert on /notifications)."""
    _segment(svc, segment_id)
    existing = _watch(svc, segment_id)
    if existing:
        return {"id": existing.id, "segment_id": segment_id, "watching": True}
    now_state = CausesEngine(svc.router).analyze(_segment(svc, segment_id))
    routine_only = not any(c.kind != "rush" for c in now_state.causes)
    with svc.session_factory() as s:
        w = SlowdownWatch(
            segment_id=segment_id, device_id=device_id, created_at=svc.clock.now(), routine_only=routine_only
        )
        s.add(w)
        s.commit()
        return {"id": w.id, "segment_id": segment_id, "watching": True}


@router.delete("/slowdowns/{segment_id}/watch", status_code=204)
def unwatch(segment_id: str, svc: Services = Depends(get_services)):
    with svc.session_factory() as s:
        for w in s.scalars(select(SlowdownWatch).where(SlowdownWatch.segment_id == segment_id, ~SlowdownWatch.done)):
            w.done = True
        s.commit()


def _impact(kind: str, inc, end, delay_min: int | None) -> str:
    lanes = f"{inc.lanes_blocked} lane{'s' if inc.lanes_blocked != 1 else ''} blocked"
    first = {
        "crash": lanes,
        "stall": lanes,
        "hazard": "Use caution",
        "roadwork": f"Until {fmt(end)}",
        "lane_closure": f"{lanes} until {fmt(end)}",
        "closure": f"Closed until about {fmt(end)}",
        "event": f"Crowds until about {fmt(end)}",
        "weather": f"Until about {fmt(end)}",
    }.get(inc.kind, "Reported")
    return f"{first} · +{delay_min} min" if delay_min else f"{first} · no delay yet"


def traffic_alerts(engine: CausesEngine, network: Network, view: ConditionsView) -> list[dict]:
    items = []
    for inc in view.live.incidents:
        seg = network.segments.get(inc.segment_id) if inc.segment_id else None
        s = engine.analyze(seg) if seg else None
        cause = next((c for c in s.causes if c.incident_id == inc.id), None) if s else None
        delay = round(cause.seconds / 60) if cause else None
        items.append(
            {
                "id": f"incident:{inc.id}",
                "group": ALERT_GROUP.get(inc.kind, "incident"),
                "kind": cause.kind if cause else "crash",
                "title": inc.title,
                "place": f"{s.road} · {s.place}" if s else (inc.detail or "Houston"),
                "impact": _impact(inc.kind, inc, view.incident_end(inc), delay),
                "detail": cause.detail if cause else inc.detail,
                "time": iso(inc.started_at),
                "delay_min": delay,
                "lat": s.lat if s else None,
                "lng": s.lng if s else None,
                "slowdown_id": s.id if s else None,
                "source": inc.source,
            }
        )
    for cid, st in view.live.crossings.items():
        c = network.crossings[cid]
        cc = view.crossing(c, view.now)
        if not (cc.live and cc.block_probability >= 1.0):
            continue
        delay = round(cc.expected_delay_s / 60)
        clears = f"Clears about {fmt(cc.clears_at)}" if cc.clears_at else "Blocked now"
        items.append(
            {
                "id": f"train:{cid}",
                "group": "train",
                "kind": "train",
                "title": "Freight train blocking crossing",
                "place": c.name,
                "impact": f"{clears} · +{delay} min" if delay else clears,
                "detail": "Sensor down, low confidence" if not st.sensor_up else "",
                "time": iso(st.blocked_since or st.updated_at),
                "delay_min": delay,
                "lat": c.lat,
                "lng": c.lng,
                "slowdown_id": c.segment_ids[0] if c.segment_ids else None,
                "source": st.source,
            }
        )
    for s in engine.slowdowns():
        if s.main.kind != "volume":
            continue
        extra = round(s.main.seconds / 60)
        items.append(
            {
                "id": f"volume:{s.id}",
                "group": "volume",
                "kind": "volume",
                "title": "Heavier than usual",
                "place": f"{s.road} · {s.place}",
                "impact": f"More traffic than usual · +{extra} min" if extra else "More traffic than usual",
                "detail": s.main.detail,
                "time": iso(s.main.started_at),
                "delay_min": extra,
                "lat": s.lat,
                "lng": s.lng,
                "slowdown_id": s.id,
                "source": s.main.source,
            }
        )
    return sorted(items, key=lambda a: a["time"] or "", reverse=True)


@router.get("/traffic-alerts")
def alerts(svc: Services = Depends(get_services)):
    """What's happening on the roads right now: incidents, roadwork, events, weather, trains
    blocking crossings and roads busier than usual, newest first, each with its delay."""
    engine = CausesEngine(svc.router)
    return {"generated_at": iso(engine.now), "items": traffic_alerts(engine, svc.network, engine.view)}


def _nearest_place(network: Network, lat: float, lng: float) -> str:
    def dist(n):
        return (n.lat - lat) ** 2 + ((n.lng - lng) * math.cos(math.radians(lat))) ** 2

    return min(network.places(), key=dist).name


def camera_status(engine: CausesEngine, network: Network, cam: dict) -> dict:
    """Area, direction and what the camera's road looks like right now."""
    seg_id = cam.get("segment_id")
    looking = None
    if not seg_id and cam.get("crossing_id") in network.crossings:
        seg_id = network.crossings[cam["crossing_id"]].segment_ids[0]
        looking = "Looking at the crossing"
    seg = network.segments.get(seg_id) if seg_id else None
    s = engine.analyze(seg) if seg else None
    if seg and not looking:
        looking = f"Looking {LOOKING.get(seg.direction, seg.direction.lower())}"
    busy = s is not None and s.is_slowdown and s.causes
    note = (f"{s.main.title} · +{s.delay_min} min" if s.delay_min else s.main.title) if busy else "Flowing normally"
    return {
        "area": _nearest_place(network, cam["lat"], cam["lng"]),
        "looking": looking,
        "level": s.level if s else "light",
        "delay_min": s.delay_min if s else 0,
        "note": note,
        "weather": bool(s and any(c.kind == "weather" for c in s.causes)),
        "slowdown_id": s.id if s else None,
    }
