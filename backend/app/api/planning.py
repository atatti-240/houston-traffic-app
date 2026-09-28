"""Routing, departure recommendations, saved trips and notifications."""

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import delete, select

from app.api.deps import get_services, is_clock_time, resolve_ends, resolve_location, resolve_time
from app.api.schemas import LatLng, Location, RecommendRequest, RouteRequest, TripIn
from app.directions.trips import recommend_response, route_response
from app.models import Notification, Trip, TripState, parse_point, point_key
from app.recommender import recommend_departure
from app.routing.avoid import avoiding
from app.routing.router import NoRouteError
from app.services import Services

router = APIRouter(tags=["planning"])

ENDS_LEAD_MIN = 30  # /recommend picks a point's way onto our roads for leaving about this early


@router.post("/route")
def route(req: RouteRequest, directions: bool = False, svc: Services = Depends(get_services)):
    """Best route, the router's alternative, and up to 3 different routes (`routes`).
    `?directions=true` adds door-to-door directions (app/directions)."""
    depart_at = resolve_time(svc, req.depart_at)
    view = svc.router.view()
    # Avoid tolls / highways: this router stays off them in every search, the extra routes' too.
    router = avoiding(svc.router, req.avoid)
    o, d = resolve_ends(svc, req.origin, req.destination, depart_at, router, req.safe_path, req.safety_weight, view)
    try:
        best, alt = router.route(o, d, depart_at, req.safe_path, safety_weight=req.safety_weight, view=view)
        return route_response(
            svc, req.origin, req.destination, best, alt, view, directions, req.heading, router=router
        )
    except NoRouteError as e:
        raise HTTPException(404, str(e)) from e


@router.post("/recommend")
def recommend(req: RecommendRequest, directions: bool = False, svc: Services = Depends(get_services)):
    """When to leave, plus the routes list. `?directions=true` adds door-to-door directions."""
    arrive_by = resolve_time(svc, req.arrive_by)
    now = svc.clock.now()
    if is_clock_time(req.arrive_by) and arrive_by <= now:
        arrive_by += timedelta(days=1)  # "08:30" at 5 PM means tomorrow morning
    view = svc.router.view()
    router = avoiding(svc.router, req.avoid)
    # Where a point joins our roads is picked once, for about when the trip leaves, and kept
    # for every departure the recommender tries.
    leave = max(now, arrive_by - timedelta(minutes=ENDS_LEAD_MIN))
    o, d = resolve_ends(svc, req.origin, req.destination, leave, router, req.safe_path, req.safety_weight, view)

    def recommend_by(extra_min: int = 0):  # door to door, the way on and off our roads comes off the buffer
        # earliest=now: never suggest leaving in the past. A deadline that already passed
        # comes back as "leave now" with on_time=False.
        return recommend_departure(
            router, o, d, arrive_by, req.safe_path, req.buffer_min + extra_min, earliest=now,
            safety_weight=req.safety_weight, view=view,
        )

    try:
        return recommend_response(
            svc, req.origin, req.destination, recommend_by, arrive_by, view, directions, router=router
        )
    except NoRouteError as e:
        raise HTTPException(404, str(e)) from e


def _stored(loc: Location) -> str:
    return point_key(loc.lat, loc.lng) if isinstance(loc, LatLng) else loc


def _location_json(value: str) -> str | dict:
    """A place id as is, a point back as {lat, lng} (what was saved)."""
    pt = parse_point(value)
    return {"lat": pt[0], "lng": pt[1]} if pt else value


def _trip_json(t: Trip) -> dict:
    return {
        "id": t.id,
        "name": t.name,
        "origin": _location_json(t.origin),
        "destination": _location_json(t.destination),
        "origin_name": t.origin_name,
        "destination_name": t.destination_name,
        "arrive_by": t.arrive_by,
        "days": t.day_list,
        "safe_path": t.safe_path,
        "safety_weight": t.weight,
        "device_id": t.device_id,
        **t.avoid.to_json(),
    }


@router.post("/trips", status_code=201)
def create_trip(body: TripIn, response: Response, svc: Services = Depends(get_services)):
    """Save a trip. Its places are place ids or points ({lat, lng}, with origin_name / destination_name).
    The same trip saved again (same device, places, arrive-by, days and safety) returns the one
    already saved (200) instead of a second copy that would alert twice."""
    for loc in (body.origin, body.destination):
        resolve_location(svc, loc)
    with svc.session_factory() as s:
        trip = Trip(
            name=body.name,
            origin=_stored(body.origin),
            destination=_stored(body.destination),
            origin_name=body.origin_name,
            destination_name=body.destination_name,
            arrive_by=body.arrive_by,
            days=",".join(str(d) for d in sorted(set(body.days))),
            safe_path=body.safe_path,
            safety_weight=body.safety_weight,
            device_id=body.device_id,
            **body.avoid.to_json(),
        )
        same = s.scalars(
            select(Trip).where(
                Trip.device_id == trip.device_id,
                Trip.origin == trip.origin,
                Trip.destination == trip.destination,
                Trip.arrive_by == trip.arrive_by,
                Trip.days == trip.days,
            )
        )
        existing = next((t for t in same if t.weight == trip.weight and t.avoid == trip.avoid), None)
        if existing is not None:
            response.status_code = 200
            return _trip_json(existing)
        s.add(trip)
        s.commit()
        return _trip_json(trip)


@router.get("/trips")
def list_trips(svc: Services = Depends(get_services)):
    with svc.session_factory() as s:
        return [_trip_json(t) for t in s.scalars(select(Trip).order_by(Trip.id))]


@router.delete("/trips/{trip_id}", status_code=204)
def delete_trip(trip_id: int, svc: Services = Depends(get_services)):
    with svc.session_factory() as s:
        if s.get(Trip, trip_id) is None:
            raise HTTPException(404, "trip not found")
        s.execute(delete(Notification).where(Notification.trip_id == trip_id))
        s.execute(delete(TripState).where(TripState.trip_id == trip_id))
        s.execute(delete(Trip).where(Trip.id == trip_id))
        s.commit()


def notification_json(n: Notification) -> dict:
    return {
        "id": n.id,
        "trip_id": n.trip_id,
        "plan_id": n.plan_id,
        "created_at": n.created_at,
        "kind": n.kind,
        "title": n.title,
        "body": n.body,
    }


@router.get("/notifications")
def notifications(since_id: int = 0, limit: int = 50, svc: Services = Depends(get_services)):
    with svc.session_factory() as s:
        rows = s.scalars(
            select(Notification).where(Notification.id > since_id).order_by(Notification.id.desc()).limit(limit)
        )
        return [notification_json(n) for n in rows]
