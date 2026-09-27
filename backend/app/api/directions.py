"""Door-to-door directions for one route of a /route or /recommend answer (the ones it sent as
"pending", or "unavailable" with a retry_after_s): the app asks for them one by one after showing
the trip. Asks that may call OSRM are limited per client (429 with retry_after_s: try again then)."""

import math
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.api.deps import get_services, resolve_location, resolve_time
from app.api.schemas import Location, route_json
from app.directions.options import route_id
from app.directions.trips import apply_patch, directions_for, door_patch, endpoint
from app.services import Services

router = APIRouter(tags=["planning"])


class DirectionsRequest(BaseModel):
    origin: Location
    destination: Location
    segment_ids: list[str] = Field(..., min_length=1, max_length=60, description="The route's segments, in order")
    depart_at: datetime | None = Field(None, description="When the route leaves (its depart_at). Defaults to now")


@router.post("/directions")
def directions(req: DirectionsRequest, request: Request, svc: Services = Depends(get_services)):
    """Turn-by-turn steps and the door-to-door line for a route (its segment ids), plus its
    times when a point is involved. Answers with what changes in that route's JSON."""
    o, d = resolve_location(svc, req.origin), resolve_location(svc, req.destination)
    segs = [svc.network.segments.get(sid) for sid in req.segment_ids]
    if any(s is None for s in segs):
        raise HTTPException(404, "Unknown segment id. See GET /segments.")
    if segs[0].from_node != o or segs[-1].to_node != d or any(a.to_node != b.from_node for a, b in zip(segs, segs[1:])):
        raise HTTPException(422, "segment_ids must be a connected path from origin to destination")
    view = svc.router.view()
    route = svc.router.evaluate(req.segment_ids, o, d, resolve_time(svc, req.depart_at), 0.0, view)
    o_ep, d_ep = endpoint(svc, req.origin), endpoint(svc, req.destination)
    path, corr = directions_for(svc, route, o_ep, d_ep, fetch=False)
    if path is None:  # not known yet: this ask may call OSRM, which everyone shares
        if svc.directions.client.enabled:
            wait = svc.directions.limiter.take(request.client.host if request.client else "")
            if wait:
                secs = math.ceil(wait)
                return JSONResponse(
                    {"detail": f"Too many directions requests. Try again in {secs} s.", "retry_after_s": secs},
                    status_code=429,
                    headers={"Retry-After": str(secs)},
                )
        path, corr = directions_for(svc, route, o_ep, d_ep, fetch=True)
    body = apply_patch(route_json(route), door_patch(route, path, corr, o_ep.is_point or d_ep.is_point))
    keep = ("geometry", "depart_at", "arrive_at", "total_min", "breakdown", "directions")
    return {"id": route_id(route), **{k: body[k] for k in keep}}
