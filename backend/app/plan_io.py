"""Plan requests and results in the docs/contracts JSON shapes (trip_request.json,
plan_result.json). Shared by the API and the scheduler that re-plans watched plans."""

from datetime import datetime

from app.planner import Place, Plan, StopRequest
from app.recommender import route_summary
from app.routing.router import CRASH_REASON_RISK, LIVE_REASON_EXTRA, TRAIN_REASON_P, Route
from app.timeutil import iso


# --- requests (stored with saved plans so they can be re-planned) ---------------------------


def place_to_json(p: Place) -> dict:
    return {"name": p.name, "node": p.node, "lat": p.lat, "lng": p.lng, "snapped_km": round(p.snapped_km, 2)}


def place_from_json(d: dict) -> Place:
    return Place(d["name"], d["node"], d["lat"], d["lng"], d.get("snapped_km", 0.0))


def request_to_json(
    start: Place, stops: list[StopRequest], depart_after: datetime, safety_weight: float, buffer_min: int
) -> dict:
    return {
        "start": place_to_json(start),
        "stops": [
            {
                **place_to_json(s.place),
                "window_start": iso(s.window_start),
                "window_end": iso(s.window_end),
                "dwell_min": s.dwell_min,
                "fixed_order": s.fixed_order,
            }
            for s in stops
        ],
        "depart_after": iso(depart_after),
        "safety_weight": safety_weight,
        "buffer_min": buffer_min,
    }


def request_from_json(d: dict) -> tuple[Place, list[StopRequest], datetime, float, int]:
    def t(v):
        return datetime.fromisoformat(v) if v else None

    stops = [
        StopRequest(place_from_json(s), t(s["window_start"]), t(s["window_end"]), s["dwell_min"], s["fixed_order"])
        for s in d["stops"]
    ]
    return place_from_json(d["start"]), stops, t(d["depart_after"]), d["safety_weight"], d["buffer_min"]


# --- results ----------------------------------------------------------------------------------


def hazards(route: Route) -> list[dict]:
    """Things on this route worth a warning, each with where the information came from."""
    out: list[dict] = []
    for c in route.crossings:
        if c.live and c.block_probability >= 1.0:
            out.append(
                {
                    "type": "crossing_blocked",
                    "name": c.name,
                    "at": iso(c.arrive_at),
                    "wait_min": round(c.expected_delay_s / 60, 1),
                    "sensor": "UP" if c.sensor_up else "DOWN",
                    "confidence": c.confidence,
                    "source": c.source,
                    "updated_at": iso(c.updated_at),
                }
            )
        elif not c.live and c.block_probability >= TRAIN_REASON_P:
            out.append(
                {
                    "type": "crossing_risk",
                    "name": c.name,
                    "at": iso(c.arrive_at),
                    "p_block": round(c.block_probability, 2),
                    "expected_delay_min": round(c.expected_delay_s / 60, 1),
                    "confidence": c.confidence,
                    "source": c.source,
                }
            )
    seen: set[str] = set()
    for s in route.segments:
        if s.closure and s.closure.id not in seen:
            seen.add(s.closure.id)
            out.append(
                {
                    "type": "closure",
                    "name": s.closure.title,
                    "road": s.name,
                    "until": iso(s.reopens_at),
                    "wait_min": round(s.closure_wait_s / 60, 1),
                    "source": s.closure.source,
                    "updated_at": iso(s.closure.updated_at),
                    "confidence": "high",
                }
            )
        inc = s.incident
        if inc and inc.id not in seen:
            seen.add(inc.id)
            out.append(
                {
                    "type": "incident",
                    "name": inc.title,
                    "kind": inc.kind,
                    "road": s.name,
                    "source": inc.source,
                    "updated_at": iso(inc.updated_at),
                    "confidence": "high",
                }
            )
        if s.live_weight >= 0.3 and s.congestion - s.predicted_congestion >= LIVE_REASON_EXTRA:
            out.append(
                {
                    "type": "live_traffic",
                    "name": s.name,
                    "congestion": round(s.congestion, 2),
                    "usual": round(s.predicted_congestion, 2),
                    "source": s.congestion_source.removeprefix("live:"),
                    "updated_at": iso(s.live_updated_at),
                    "confidence": s.confidence,
                }
            )
    worst: dict[str, float] = {}
    for s in route.segments:
        if s.road_class == "freeway" and s.crash_risk >= CRASH_REASON_RISK:
            worst[s.name] = max(worst.get(s.name, 0.0), s.crash_risk)
    for name, risk in worst.items():
        out.append({"type": "high_crash_risk", "name": name, "risk": round(risk, 2), "confidence": "medium", "source": "history"})
    unique, keys = [], set()
    for h in out:
        key = (h["type"], h["name"])
        if key not in keys:
            keys.add(key)
            unique.append(h)
    return unique


def _breakdown(r: Route) -> dict:
    return {
        "base_travel_min": round(r.base_travel_s / 60, 1),
        "train_delay_min": round(r.train_delay_s / 60, 1),
        "closure_wait_min": round(r.closure_wait_s / 60, 1),
        "crash_exposure": round(r.crash_exposure, 3),
    }


def plan_to_json(plan: Plan, plan_id: str, created_at: datetime | None = None, watch: bool = False) -> dict:
    legs = []
    for leg in plan.legs:
        r = leg.route
        legs.append(
            {
                "from": leg.frm.name,
                "to": leg.to.name,
                "leave_at": iso(leg.leave_at),
                "leave_at_safe": iso(leg.leave_at_safe),
                "arrive_at": iso(leg.arrive_at),
                "drive_min": round(r.total_s / 60),
                "freeflow_min": round(r.free_flow_s / 60),
                "miles": round(sum(s.miles for s in r.segments), 1),
                "breakdown": _breakdown(r),
                "geometry": r.geometry,
                "hazards": hazards(r),
                "why": r.reasons,
                # beyond the contract
                "summary": route_summary(r),
                "window": {"start": iso(leg.stop.window_start), "end": iso(leg.stop.window_end)},
                "dwell_min": leg.stop.dwell_min,
                "wait_min": round(leg.wait_min),
                "late_min": round(leg.late_min),
                "tight": leg.tight,
                "confidence": leg.confidence,
                "safety_weight": r.safety_weight,
            }
        )
    route_points = [plan.start] + [s.place for s in plan.order]
    first = plan.order[0].place
    saved = plan.baseline.drive_min - plan.drive_min
    return {
        "plan_id": plan_id,
        "created_at": iso(created_at or plan.now),
        "planned_at": iso(plan.now),
        "status": plan.status,
        "order": plan.order_names,
        "legs": legs,
        "late_stops": [{"name": leg.to.name, "late_min": round(leg.late_min)} for leg in plan.late_stops],
        "baseline": {
            "description": "typed order, leave now, traffic-only routes (no crossing or crash awareness)",
            "total_min": round(plan.baseline.drive_min),
            "wait_min": round(plan.baseline.wait_min),
            "late_stops": plan.baseline.late_stops,
        },
        "saved_min_vs_baseline": round(saved),
        "navigate_links": {
            "waze": f"https://waze.com/ul?ll={first.lat},{first.lng}&navigate=yes",
            "google": "https://www.google.com/maps/dir/" + "/".join(f"{p.lat},{p.lng}" for p in route_points),
        },
        "data_freshness": plan.freshness,
        # beyond the contract
        "watch": watch,
        "safety_weight": plan.safety_weight,
        "buffer_min": plan.buffer_min,
        "drive_min": round(plan.drive_min),
        "warnings": plan.warnings,
        "places": {
            "start": place_to_json(plan.start),
            "stops": [place_to_json(s.place) for s in plan.stops],
        },
    }
