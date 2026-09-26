"""Request/response models and serializers."""

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field, model_validator

from app.conditions.live import Incident
from app.plan_io import hazards
from app.recommender import Recommendation, route_summary
from app.routing.router import Route

SafetyWeight = Annotated[
    float | None,
    Field(ge=0, le=1, description="0 = fastest, 1 = safest. Overrides safe_path when given."),
]


class LatLng(BaseModel):
    lat: float
    lng: float


Location = str | LatLng  # node id / place id, or a point that snaps to the nearest node


class RouteRequest(BaseModel):
    origin: Location
    destination: Location
    depart_at: datetime | None = Field(None, description="Defaults to the simulated now")
    safe_path: bool = False
    safety_weight: SafetyWeight = None


class RecommendRequest(BaseModel):
    origin: Location
    destination: Location
    arrive_by: str = Field(
        ..., description="ISO datetime, or HH:MM meaning the next time that clock time comes up (simulated)"
    )
    safe_path: bool = False
    safety_weight: SafetyWeight = None
    buffer_min: int = Field(5, ge=0, le=60)


class TripIn(BaseModel):
    name: str = "My commute"
    origin: str
    destination: str
    arrive_by: str = Field(..., pattern=r"^([01]\d|2[0-3]):[0-5]\d$", description="24h HH:MM")
    days: list[Annotated[int, Field(ge=0, le=6)]] = Field(
        default_factory=lambda: [0, 1, 2, 3, 4], min_length=1, description="Weekdays, Mon=0 .. Sun=6"
    )
    safe_path: bool = False
    safety_weight: SafetyWeight = None
    device_id: str | None = None


# --- multi-stop plans (docs/contracts/trip_request.json) -------------------------------------

TimeIn = Field(None, description="ISO datetime (an offset like -05:00 is converted to Houston time) or HH:MM")


class PlaceIn(BaseModel):
    """A place by id (GET /places) or by coordinates (snapped to the nearest road-map point)."""

    name: str | None = None
    place: str | None = Field(None, description="Place id from GET /places")
    lat: float | None = Field(None, ge=-90, le=90)
    lng: float | None = Field(None, ge=-180, le=180)

    @model_validator(mode="after")
    def _where(self):
        if self.place is None and (self.lat is None or self.lng is None):
            raise ValueError("give either place or both lat and lng")
        return self


class StopIn(PlaceIn):
    window_start: str | None = TimeIn
    window_end: str | None = TimeIn
    dwell_min: float = Field(0, ge=0, le=480)
    fixed_order: bool = False


class TripPlanRequest(BaseModel):
    name: str | None = None
    device_id: str | None = None
    start: PlaceIn
    depart_after: str | None = Field(
        None, description="Defaults to the simulated now. ISO, or HH:MM meaning the next time that clock time comes up"
    )
    stops: list[StopIn] = Field(..., min_length=1, max_length=3)
    safe_path: bool = False
    safety_weight: SafetyWeight = None
    buffer_min: int = Field(5, ge=0, le=60)
    watch: bool = Field(False, description="Re-plan every 5 min and send alerts until the trip is done")


MAX_ADVANCE_MIN = 366 * 24 * 60  # a year, same limit as other times


class AdvanceClockRequest(BaseModel):
    minutes: float | None = Field(None, ge=-MAX_ADVANCE_MIN, le=MAX_ADVANCE_MIN)
    to: datetime | None = None


class BlockCrossingRequest(BaseModel):
    crossing_id: str
    minutes: float = Field(20, gt=0, le=180)
    start: datetime | None = None


Confidence = Literal["high", "medium", "low"]


class LiveTrafficRequest(BaseModel):
    segment_ids: list[str] = Field(..., min_length=1, description="Graph segment ids (GET /segments)")
    congestion: float = Field(..., ge=0, le=1, description="0 = free flow, 1 = stopped")
    source: str = "demo"
    confidence: Confidence = "high"
    minutes_ago: float = Field(0, ge=0, le=120)
    detail: str = ""


class IncidentRequest(BaseModel):
    segment_id: str
    kind: Literal["crash", "stall", "roadwork", "closure", "hazard", "other"] = "crash"
    title: str | None = None
    minutes: float | None = Field(45, gt=0, le=600, description="How long until it clears; null = unknown")
    lanes_blocked: int = Field(1, ge=1, le=6)
    start: datetime | None = None


class CrossingSensorRequest(BaseModel):
    crossing_id: str
    up: bool


class FeedRequest(BaseModel):
    feed: Literal["trains", "traffic", "incidents"]
    up: bool


def incident_json(inc: Incident | None, clears_at: datetime | None = None) -> dict | None:
    if inc is None:
        return None
    return {
        "id": inc.id,
        "title": inc.title,
        "kind": inc.kind,
        "segment_id": inc.segment_id,
        "started_at": inc.started_at,
        "clears_at": clears_at or inc.clears_at,
        "lanes_blocked": inc.lanes_blocked,
        "source": inc.source,
        "updated_at": inc.updated_at,
        "detail": inc.detail,
    }


def route_json(r: Route | None) -> dict | None:
    if r is None:
        return None
    return {
        "origin": r.origin,
        "destination": r.destination,
        "depart_at": r.depart_at,
        "arrive_at": r.arrive_at,
        "total_min": round(r.total_s / 60, 1),
        "safe_path": r.safe_path,
        "safety_weight": r.safety_weight,
        "confidence": r.confidence,
        "feeds_down": r.feeds_down,
        "summary": route_summary(r),
        "breakdown": {
            "free_flow_min": round(r.free_flow_s / 60, 1),
            "base_travel_min": round(r.base_travel_s / 60, 1),
            "train_delay_min": round(r.train_delay_s / 60, 1),
            "closure_wait_min": round(r.closure_wait_s / 60, 1),
            "crash_exposure": round(r.crash_exposure, 3),
            "max_crash_risk": round(r.max_crash_risk, 3),
            "max_block_probability": round(r.max_block_probability, 3),
        },
        "reasons": r.reasons,
        "hazards": hazards(r),
        "geometry": r.geometry,
        "segments": [
            {
                "id": s.id,
                "name": s.name,
                "road_class": s.road_class,
                "enter_at": s.enter_at,
                "travel_min": round(s.travel_s / 60, 2),
                "train_delay_min": round(s.train_delay_s / 60, 2),
                "congestion": round(s.congestion, 3),
                "predicted_congestion": round(s.predicted_congestion, 3),
                "congestion_source": s.congestion_source,
                "live_weight": round(s.live_weight, 2),
                "live_updated_at": s.live_updated_at,
                "incident": incident_json(s.incident),
                "incident_slowdown": round(s.incident_slowdown, 2),
                "closure": incident_json(s.closure),
                "closure_wait_min": round(s.closure_wait_s / 60, 1),
                "confidence": s.confidence,
                "crash_risk": round(s.crash_risk, 3),
                "miles": round(s.miles, 2),
                "geometry": s.geometry,
            }
            for s in r.segments
        ],
        "crossings": [
            {
                "id": c.id,
                "name": c.name,
                "lat": c.lat,
                "lng": c.lng,
                "arrive_at": c.arrive_at,
                "block_probability": round(c.block_probability, 3),
                "expected_delay_min": round(c.expected_delay_s / 60, 1),
                "live": c.live,
                "sensor": None if c.sensor_up is None else ("UP" if c.sensor_up else "DOWN"),
                "confidence": c.confidence,
                "source": c.source,
                "updated_at": c.updated_at,
            }
            for c in r.crossings
        ],
    }


def recommendation_json(rec: Recommendation) -> dict:
    return {
        "depart_at": rec.depart_at,
        "arrive_by": rec.arrive_by,
        "eta": rec.eta,
        "on_time": rec.on_time,
        "lead_min": round(rec.lead_minutes),
        "buffer_min": rec.buffer_min,
        "leave_at_safe": rec.leave_at_safe,
        "confidence": rec.confidence,
        "confidence_label": rec.confidence_label,
        "data_confidence": rec.data_confidence,
        "route": route_json(rec.route),
        "alternative": route_json(rec.alternative),
    }
