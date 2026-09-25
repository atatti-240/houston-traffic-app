"""Routing, departure recommendations, saved trips and notifications."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select

from app.api.deps import get_services, resolve_location, resolve_time
from app.api.schemas import RecommendRequest, RouteRequest, TripIn, recommendation_json, route_json
from app.models import Notification, Trip, TripState
from app.recommender import recommend_departure
from app.routing.router import NoRouteError
from app.services import Services

router = APIRouter(tags=["planning"])


@router.post("/route")
def route(req: RouteRequest, svc: Services = Depends(get_services)):
    o, d = resolve_location(svc, req.origin), resolve_location(svc, req.destination)
    try:
        best, alt = svc.router.route(o, d, resolve_time(svc, req.depart_at), req.safe_path)
    except NoRouteError as e:
        raise HTTPException(404, str(e)) from e
    return {"best": route_json(best), "alternative": route_json(alt)}


@router.post("/recommend")
def recommend(req: RecommendRequest, svc: Services = Depends(get_services)):
    o, d = resolve_location(svc, req.origin), resolve_location(svc, req.destination)
    arrive_by = resolve_time(svc, req.arrive_by)
    now = svc.clock.now()
    earliest = now if arrive_by.date() == now.date() and arrive_by > now else None
    try:
        rec = recommend_departure(svc.router, o, d, arrive_by, req.safe_path, req.buffer_min, earliest)
    except NoRouteError as e:
        raise HTTPException(404, str(e)) from e
    return recommendation_json(rec)


def _trip_json(t: Trip) -> dict:
    return {
        "id": t.id,
        "name": t.name,
        "origin": t.origin,
        "destination": t.destination,
        "arrive_by": t.arrive_by,
        "days": t.day_list,
        "safe_path": t.safe_path,
        "device_id": t.device_id,
    }


@router.post("/trips", status_code=201)
def create_trip(body: TripIn, svc: Services = Depends(get_services)):
    for loc in (body.origin, body.destination):
        resolve_location(svc, loc)
    with svc.session_factory() as s:
        trip = Trip(
            name=body.name,
            origin=body.origin,
            destination=body.destination,
            arrive_by=body.arrive_by,
            days=",".join(str(d) for d in sorted(set(body.days))),
            safe_path=body.safe_path,
            device_id=body.device_id,
        )
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
