"""Walk and bike: the Trip screen's other tabs. No traffic data involved."""

from datetime import datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.api.deps import get_services, resolve_time
from app.services import Services
from app.travel import osrm

router = APIRouter(tags=["walk, bike"])


class Point(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lng: float = Field(..., ge=-180, le=180)


class WalkBikeRequest(BaseModel):
    mode: Literal["walk", "bike"]
    origin: Point
    destination: Point
    depart_at: str | None = Field(None, description="ISO or HH:MM; defaults to the simulated now")


def walk_bike_router(request: Request) -> osrm.WalkBikeRouter:
    return getattr(request.app.state, "walk_bike", None) or osrm.default_router()


@router.post("/travel/route")
def walk_bike(req: WalkBikeRequest, request: Request, svc: Services = Depends(get_services)):
    """Walking or cycling directions (OpenStreetMap), with plain-language steps."""
    depart: datetime = resolve_time(svc, req.depart_at)
    a, b = (req.origin.lat, req.origin.lng), (req.destination.lat, req.destination.lng)
    what = "Walking" if req.mode == "walk" else "Cycling"
    try:
        r = walk_bike_router(request).route(req.mode, a, b)
    except osrm.BadRequest as e:
        raise HTTPException(422, str(e)) from e
    except osrm.NoRoute as e:
        raise HTTPException(404, f"No {what.lower()} route between those two points.") from e
    except osrm.RoutingUnavailable as e:
        raise HTTPException(
            503, f"{what} directions aren't available right now: the OpenStreetMap routing service didn't answer. Try again in a minute."
        ) from e
    return {**r, "depart_at": depart, "arrive_at": depart + timedelta(seconds=r["duration_s"])}
