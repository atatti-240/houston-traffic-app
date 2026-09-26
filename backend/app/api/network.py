"""Read-only map data: places, segments, scores, crossings, cameras, live conditions."""

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends

from app.api.deps import get_services, resolve_time
from app.api.schemas import incident_json
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
    """Congestion per segment at `at`: the prediction, blended with fresh live readings when
    `at` is within 30 min of now. `sources` lists the segments that used live data and
    `incidents` the ones slowed or closed by an incident."""
    t = resolve_time(svc, at)
    view = svc.router.view()
    scores, sources, incidents = {}, {}, {}
    for seg in svc.network.segments.values():
        sc = view.segment(seg, t)
        scores[seg.id] = round(sc.congestion, 3)
        if sc.live_weight > 0:
            sources[seg.id] = {
                "source": sc.congestion_source,
                "live_weight": round(sc.live_weight, 2),
                "predicted": round(sc.predicted_congestion, 3),
                "updated_at": sc.live_updated_at,
            }
        if sc.incident or sc.closed:
            incidents[seg.id] = {"closed": sc.closed, "slowdown": round(sc.incident_slowdown, 2), "title": sc.incident.title if sc.incident else ""}
    return {"at": t, "scores": scores, "sources": sources, "incidents": incidents}


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
    view = svc.router.view()
    out = []
    for c in svc.network.crossings.values():
        cc = view.crossing(c, t)
        blocked = cc.live and cc.block_probability >= 1.0
        out.append(
            {
                "id": c.id,
                "name": c.name,
                "lat": c.lat,
                "lng": c.lng,
                "rail_line": c.rail_line,
                "segment_ids": list(c.segment_ids),
                "block_probability": round(cc.block_probability, 3),
                "expected_delay_min": round(cc.expected_delay_s / 60, 1),
                "live_blocked_until": cc.arrive_at + timedelta(seconds=cc.expected_delay_s) if blocked else None,
                "live": cc.live,
                "sensor": None if cc.sensor_up is None else ("UP" if cc.sensor_up else "DOWN"),
                "confidence": cc.confidence,
                "source": cc.source,
                "updated_at": cc.updated_at,
            }
        )
    return {"at": t, "crossings": out}


@router.get("/cameras")
def cameras(svc: Services = Depends(get_services)):
    return svc.sources.cameras.cameras()


def _midpoint(geometry) -> tuple[float, float] | None:
    """Middle of a polyline's vertices (between the two middle ones when there's an even count)."""
    if not geometry:
        return None
    n = len(geometry)
    a, b = geometry[(n - 1) // 2], geometry[n // 2]
    return (a[0] + b[0]) / 2, (a[1] + b[1]) / 2


@router.get("/live")
def live(svc: Services = Depends(get_services)):
    """What the live feeds say right now (docs/contracts/live_conditions.json): crossing status
    with sensor health, cameras, incidents, live travel times and which feeds are down."""
    view = svc.router.view()
    now = view.now
    cams = svc.sources.cameras.cameras()
    cam_for_crossing = {c["crossing_id"]: c["id"] for c in cams if c.get("crossing_id")}

    crossings = []
    for c in svc.network.crossings.values():
        st = view.live.crossings.get(c.id)
        cc = view.crossing(c, now)
        blocked = cc.live and cc.block_probability >= 1.0
        status = "blocked" if blocked else ("clear" if st is not None else "unknown")
        crossings.append(
            {
                "id": c.id,
                "street": c.name,
                "lat": c.lat,
                "lng": c.lng,
                "status": status,
                "time_to_clear_min": round(cc.expected_delay_s / 60, 1) if blocked else None,
                "sensor": None if st is None else ("UP" if st.sensor_up else "DOWN"),
                "confidence": cc.confidence,
                "p_block_now": None if blocked else round(svc.models.train.get_block_probability(c.id, now), 2),
                "source": st.source if st else "history",
                "updated_at": st.updated_at if st else None,
                "nearest_camera_id": cam_for_crossing.get(c.id),
            }
        )

    cameras = []
    for cam in cams:
        reading = None
        if cam.get("segment_id"):
            reading = next((r for r in view.live.traffic.get(cam["segment_id"], ()) if r.source == "camera"), None)
        cameras.append(
            {
                "id": cam["id"],
                "name": cam["name"],
                "kind": cam.get("kind"),
                "lat": cam["lat"],
                "lng": cam["lng"],
                "snapshot_url": cam.get("url"),
                "segment_id": cam.get("segment_id"),
                "crossing_id": cam.get("crossing_id"),
                "congestion": round(reading.congestion, 2) if reading else None,
                "detail": reading.detail if reading else "",
                "updated_at": reading.observed_at if reading else None,
                "mock": cam.get("mock", False),
            }
        )

    incidents = []
    for inc in view.live.incidents:
        seg = svc.network.segments.get(inc.segment_id) if inc.segment_id else None
        at = _midpoint(seg.geometry) if seg else None
        incidents.append(
            {
                **incident_json(inc, view.incident_end(inc)),
                "road": seg.name if seg else None,
                "lat": at[0] if at else None,
                "lng": at[1] if at else None,
                "affects_routing": seg is not None,
            }
        )

    travel_times = []
    for sid in view.live.traffic:
        seg = svc.network.segments[sid]
        sc = view.segment(seg, now)
        if sc.live_weight <= 0:
            continue  # stale reading
        travel_times.append(
            {
                "segment_id": sid,
                "segment": seg.name,
                "minutes": round(sc.travel_s / 60, 1),
                "historical_minutes": round(svc.models.congestion.get_segment_travel_time(sid, now) / 60, 1),
                "congestion": round(sc.congestion, 2),
                "usual_congestion": round(sc.predicted_congestion, 2),
                "source": sc.congestion_source.removeprefix("live:"),
                "confidence": sc.confidence,
                "detail": sc.live_detail,
                "updated_at": sc.live_updated_at,
            }
        )

    return {
        "generated_at": now,
        "crossings": crossings,
        "cameras": cameras,
        "incidents": incidents,
        "travel_times": travel_times,
        "feeds": {
            f.name: {"ok": f.ok, "records": f.records, "error": f.error} for f in view.live.feeds.values()
        },
        "data_freshness": view.freshness(),
    }
