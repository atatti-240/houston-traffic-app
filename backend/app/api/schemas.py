"""Request/response models and serializers."""

from datetime import datetime

from typing import Annotated

from pydantic import BaseModel, Field

from app.recommender import Recommendation, route_summary
from app.routing.router import Route


class LatLng(BaseModel):
    lat: float
    lng: float


Location = str | LatLng  # node id / place id, or a point that snaps to the nearest node


class RouteRequest(BaseModel):
    origin: Location
    destination: Location
    depart_at: datetime | None = Field(None, description="Defaults to the simulated now")
    safe_path: bool = False


class RecommendRequest(BaseModel):
    origin: Location
    destination: Location
    arrive_by: str = Field(
        ..., description="ISO datetime, or HH:MM meaning the next time that clock time comes up (simulated)"
    )
    safe_path: bool = False
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
    device_id: str | None = None


class AdvanceClockRequest(BaseModel):
    minutes: float | None = None
    to: datetime | None = None


class BlockCrossingRequest(BaseModel):
    crossing_id: str
    minutes: float = Field(20, gt=0, le=180)
    start: datetime | None = None


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
        "summary": route_summary(r),
        "breakdown": {
            "free_flow_min": round(r.free_flow_s / 60, 1),
            "base_travel_min": round(r.base_travel_s / 60, 1),
            "train_delay_min": round(r.train_delay_s / 60, 1),
            "crash_exposure": round(r.crash_exposure, 3),
            "max_crash_risk": round(r.max_crash_risk, 3),
            "max_block_probability": round(r.max_block_probability, 3),
        },
        "reasons": r.reasons,
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
        "confidence": rec.confidence,
        "confidence_label": rec.confidence_label,
        "route": route_json(rec.route),
        "alternative": route_json(rec.alternative),
    }
