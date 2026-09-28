"""The routes list for /route and /recommend: up to 3 routes, each with its label, main road,
delay causes and (when asked for) door-to-door directions.

With `directions`, the first route's directions are built right away (at most one OSRM call
when it isn't cached; a trip to an arbitrary point needs them for its times). The others come
from the cache or say "pending": the app asks POST /directions for them one by one, so a new
trip shows up after one OSRM call instead of three (the public server allows ~1 per second).
"""

import math
from collections.abc import Callable
from datetime import datetime, timedelta
from functools import cache

from app.api.schemas import LatLng, Location, recommendation_json, route_json
from app.conditions.provider import ConditionsView
from app.directions import geo
from app.directions.door import Corridor, DoorPath, Endpoint, door_timing
from app.directions.ends import street_s
from app.directions.options import delay_causes, route_id, route_labels, route_options
from app.recommender import Recommendation
from app.routing.router import Route, Router
from app.services import Services

PENDING = {
    "status": "pending",
    "steps": [],
    "distance_m": None,
    "access_min": None,
    "note": None,
    "retry_after_s": None,
}

STREETS_NOTE = "Turn-by-turn directions aren't available right now. The time is a rough guess for city streets."


def endpoint(svc: Services, loc: Location, heading: float | None = None) -> Endpoint:
    """The real start or end of a trip: the point itself, or a place's own spot. `heading`: the way
    you're going at that point (a re-plan while driving), in compass degrees."""
    if isinstance(loc, LatLng):
        bearing = None if heading is None else round(heading) % 360
        return Endpoint(loc.lat, loc.lng, True, bearing)
    node = svc.network.nodes[loc]
    return Endpoint(node.lat, node.lng, False)


def door_patch(route: Route, path: DoorPath | None, corr: Corridor, timed: bool) -> dict:
    """What door-to-door directions change in a route's JSON. `timed`: the trip starts or ends
    at an arbitrary point, so its times include the way there (between our places they don't)."""
    if path is None:
        return {"directions": dict(PENDING)}
    t = door_timing(route, corr, path) if timed else None
    out: dict = {
        "directions": {
            "status": path.status,
            "steps": path.steps,
            "distance_m": path.distance_m,
            "access_min": None
            if t is None
            else {"start": round(path.access_start_s / 60, 1), "end": round(path.access_end_s / 60, 1)},
            "note": f"{path.note} Times cover the main roads only." if timed and t is None and path.note else path.note,
            # Unavailable only for now (OSRM down or busy): ask POST /directions again in that many seconds
            "retry_after_s": path.retry_after_s,
        }
    }
    if path.geometry:
        out["geometry"] = path.geometry
    if t is not None:
        out["arrive_at"] = t.arrive_at
        out["total_min"] = round(t.total_s / 60, 1)
        out["breakdown"] = {
            "free_flow_min": round(t.free_flow_s / 60, 1),
            "base_travel_min": round(t.travel_s / 60, 1),
            "train_delay_min": round(t.train_delay_s / 60, 1),
            "closure_wait_min": round(t.closure_wait_s / 60, 1),
            "access_min": round(t.access_s / 60, 1),
        }
    return out


def street_s_between(o: Endpoint, d: Endpoint) -> float:
    return street_s(geo.dist_m(o.latlng, d.latlng))


def streets_only(route: Route, o: Endpoint, d: Endpoint) -> bool:
    """Door to door on city streets (no main roads) between two real spots around Houston."""
    return not route.segment_ids and (o.is_point or d.is_point) and o.near(*d.latlng)


def street_patch(route: Route, o: Endpoint, d: Endpoint, drawn: bool) -> dict:
    """A door-to-door trip on city streets only (the empty route: app/directions/ends.py) with no
    street directions (not asked for, or OSRM down): a rough time for the straight line instead
    of 0 min, and with `drawn` that line between the pins, so the trip still shows a way there."""
    s = street_s_between(o, d)
    out: dict = {
        "arrive_at": route.depart_at + timedelta(seconds=s),
        "total_min": round(s / 60, 1),
        "breakdown": {"free_flow_min": round(s / 60, 1), "base_travel_min": round(s / 60, 1), "access_min": round(s / 60, 1)},
    }
    if drawn:
        out["geometry"] = [o.latlng, d.latlng]
        # Asking POST /directions again can't help an empty route: no retry
        out["directions"] = {**PENDING, "status": "unavailable", "note": STREETS_NOTE}
    return out


def apply_patch(body: dict, patch: dict) -> dict:
    breakdown = {**body.get("breakdown", {}), **patch.get("breakdown", {})}
    return {**body, **patch, "breakdown": breakdown}


def directions_for(
    svc: Services, route: Route, o: Endpoint, d: Endpoint, fetch: bool
) -> tuple[DoorPath | None, Corridor]:
    segs = [svc.network.segments[sid] for sid in route.segment_ids]
    corr = Corridor(segs)
    start, end = svc.network.nodes[route.origin], svc.network.nodes[route.destination]
    if not (o.near(start.lat, start.lng) and d.near(end.lat, end.lng)):
        return svc.directions.too_far(corr), corr
    path = svc.directions.build(segs, o, d) if fetch else svc.directions.cached(segs, o, d)
    return path, corr


def routes_json(svc: Services, routes: list[Route], o: Endpoint, d: Endpoint, directions: bool) -> list[dict]:
    labels = route_labels(svc.network, routes)
    timed = o.is_point or d.is_point
    out = []
    for i, (r, (label, main)) in enumerate(zip(routes, labels)):
        body = {
            **route_json(r),
            "id": route_id(r),
            "label": label,
            "main_road": main,
            "delay_causes": delay_causes(svc.network, r),
        }
        if directions:
            path, corr = directions_for(svc, r, o, d, fetch=i == 0)
            body = apply_patch(body, door_patch(r, path, corr, timed))
        if streets_only(r, o, d) and (not directions or body["directions"]["status"] == "unavailable"):
            body = apply_patch(body, street_patch(r, o, d, directions))
        out.append(body)
    return out


def _alternative(alt: Route | None, items: list[dict]) -> dict | None:
    """The router's own alternative, as before (the routes list may have left it out)."""
    if alt is None:
        return None
    rid = route_id(alt)
    return next((x for x in items if x["id"] == rid), None) or {**route_json(alt), "id": rid}


def route_response(
    svc: Services,
    origin: Location,
    destination: Location,
    best: Route,
    alt: Route | None,
    view: ConditionsView,
    directions: bool,
    heading: float | None = None,
    router: Router | None = None,
) -> dict:
    """POST /route: best + alternative (as before) + the routes list. `heading`: the way you're
    going at the origin (driving), so the directions start that way. `router` is the one that
    found `best` (it may stay off tolls or highways: app.routing.avoid); the extra routes use it too."""
    router = router or svc.router
    naive = cache(lambda: router.traffic_only_route(best.origin, best.destination, best.depart_at, view))
    routes = route_options(router, best, alt, view, naive)
    items = routes_json(svc, routes, endpoint(svc, origin, heading), endpoint(svc, destination), directions)
    return {"best": items[0], "alternative": _alternative(alt, items), "routes": items}


def recommend_response(
    svc: Services,
    origin: Location,
    destination: Location,
    recommend_by: Callable[[int], Recommendation],
    arrive_by: datetime,
    view: ConditionsView,
    directions: bool,
    router: Router | None = None,
) -> dict:
    """POST /recommend: the departure (door to door when a point is involved) + the routes list.
    `recommend_by(extra_min)` runs the recommender with that many minutes added to the buffer.

    To or from an arbitrary point the way on and off our roads takes time too: the departure is
    picked again with the difference between the door-to-door trip and our corridor (rounded up
    to a minute) taken from the buffer, so departures stay on the usual 5-minute marks. OSRM is
    called for the chosen route only, never in the recommender's loop. `router` is the one the
    recommender used (it may stay off tolls or highways); the extra routes use it too."""
    router = router or svc.router
    o, d = endpoint(svc, origin), endpoint(svc, destination)
    rec = recommend_by(0)
    buffer_min = rec.buffer_min
    if o.is_point or d.is_point:
        extra_s = 0.0
        t = None
        if directions:
            path, corr = directions_for(svc, rec.route, o, d, fetch=True)
            t = door_timing(rec.route, corr, path)
            extra_s = t.total_s - rec.route.total_s if t is not None else 0.0
        if t is None and streets_only(rec.route, o, d):  # city streets only, no directions: a rough time
            extra_s = street_s_between(o, d)
        extra = math.ceil(extra_s / 60)
        if extra:
            rec = recommend_by(extra)
            rec.buffer_min = buffer_min
    r0 = rec.route
    naive = cache(lambda: router.traffic_only_route(r0.origin, r0.destination, r0.depart_at, view))
    routes = route_options(router, r0, rec.alternative, view, naive)
    items = routes_json(svc, routes, o, d, directions)
    body = recommendation_json(rec)
    body.update(route=items[0], alternative=_alternative(rec.alternative, items), routes=items)
    eta = items[0]["arrive_at"]
    if eta != rec.eta:  # door to door: judge being on time by the real arrival
        body["eta"] = eta
        body["on_time"] = eta + timedelta(minutes=buffer_min) <= arrive_by
    return body
