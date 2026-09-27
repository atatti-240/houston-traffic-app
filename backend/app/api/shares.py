"""Share ETA links: POST /shares makes one from a route, GET /shares/{id} is what the link shows.
See app/shares.py for what's stored and how the ETA is re-checked."""

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app import shares
from app.api.deps import get_services, haversine_km, resolve_time
from app.services import Services
from app.shares import Share, ShareError

router = APIRouter(tags=["share"])

EXPIRED = "This link expired"  # unknown, malformed and expired ids all get this
MAX_PIN_KM = 25  # a destination pin further than this from the route's end is ignored


class Pin(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lng: float = Field(..., ge=-180, le=180)


class ShareRequest(BaseModel):
    segment_ids: list[Annotated[str, Field(max_length=64)]] = Field(
        ..., min_length=1, max_length=shares.MAX_SEGMENTS, description="The route's segments, in order (route.segments[].id)"
    )
    depart_at: datetime | None = Field(
        None, description="Planned leave time. Omitted or already past = now (simulated); at most 24 h ahead"
    )
    origin_name: str = Field("", max_length=200)
    destination_name: str = Field("", max_length=200)
    destination: Pin | None = Field(
        None, description="Where to put the destination pin (e.g. a shop near the route's end); defaults to the end"
    )


def _limiter(request: Request) -> shares.RateLimiter:
    lim = getattr(request.app.state, "share_limiter", None)
    if lim is None:
        lim = request.app.state.share_limiter = shares.RateLimiter(shares.RATE_LIMIT, shares.RATE_WINDOW_S)
    return lim


@router.post("/shares", status_code=201)
def create_share(req: ShareRequest, request: Request, svc: Services = Depends(get_services)):
    """Make a Share ETA link for a route. The route is rebuilt from its segment ids (geometry
    from our road map) and its ETA worked out here. The link works until 6 hours after the trip
    starts (6 h from now for a trip leaving now)."""
    if not _limiter(request).allow(request.client.host if request.client else "unknown"):
        raise HTTPException(429, "Too many share links from here. Try again in a while.", headers={"Retry-After": "600"})
    net = svc.network
    ids = req.segment_ids
    try:
        shares.check_route(net, ids)
    except ShareError as e:
        raise HTTPException(422, str(e)) from e
    now = svc.clock.now()
    depart_at = max(now, resolve_time(svc, req.depart_at))  # nobody leaves in the past
    if depart_at - now > shares.MAX_AHEAD:
        raise HTTPException(422, "Share links are for trips leaving within the next 24 hours")

    first, last = net.segments[ids[0]], net.segments[ids[-1]]
    geometry = shares.route_geometry(net, ids)
    end = geometry[-1]
    if req.destination is not None:
        pin = [req.destination.lat, req.destination.lng]
        if haversine_km(end[0], end[1], pin[0], pin[1]) <= MAX_PIN_KM:
            end = pin
    eta, enter_at = shares.route_eta(svc.router, ids, depart_at)
    wall = shares.wall_now()
    share = Share(
        id=shares.new_id(),
        origin_name=shares.clean_name(req.origin_name, net.nodes[first.from_node].name),
        destination_name=shares.clean_name(req.destination_name, net.nodes[last.to_node].name),
        main_road=shares.main_road(net, ids),
        segment_ids=list(ids),
        geometry=geometry,
        end_point=end,
        miles=sum(net.segments[sid].length_miles for sid in ids),
        depart_at=depart_at,
        shared_eta=eta,
        eta=eta,
        created_at=now,
        created_wall=wall,
        expires_at=shares.expires_at(wall, now, depart_at),
    )
    shares.set_schedule(share, enter_at)
    with svc.session_factory() as s:
        shares.make_room(s, wall)
        s.add(share)
        s.commit()
    return {
        "id": share.id,
        "depart_at": share.depart_at,
        "eta": share.eta,
        "main_road": share.main_road,
        "expires_in_min": round((share.expires_at - wall).total_seconds() / 60),
    }


@router.get("/shares/{share_id}")
def get_share(share_id: str, svc: Services = Depends(get_services)):
    """What a Share ETA link shows: the route, names, and the ETA re-checked just now (leaving at
    the planned time, under current conditions). Nothing else about the trip or who shared it."""
    if not shares.valid_id(share_id):
        raise HTTPException(404, EXPIRED)
    wall = shares.wall_now()
    with svc.session_factory() as s:
        share = s.get(Share, share_id)
        if share is None or share.expires_at <= wall:
            raise HTTPException(404, EXPIRED)
        now = svc.clock.now()
        checked = shares.refresh(svc.router, share, now)
        if checked:
            s.commit()
        return {
            "origin_name": share.origin_name,
            "destination_name": share.destination_name,
            "main_road": share.main_road,
            "miles": round(share.miles, 1),
            "geometry": share.geometry,
            "end": share.end_point,
            "depart_at": share.depart_at,
            "shared_eta": share.shared_eta,
            "eta": share.eta,
            "status": shares.status(share, now),  # not_left | on_the_way | arrived
            "checked": checked,  # false: this is the last ETA we had (trip should be over, or road map changed)
            "now": now,
            "shared_at": share.created_at,
            "expires_in_min": max(0, int((share.expires_at - wall).total_seconds() // 60)),
        }
