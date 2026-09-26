import math
from datetime import date, datetime, time, timedelta

from fastapi import HTTPException, Request

from app.api.schemas import LatLng, Location, PlaceIn
from app.planner import Place
from app.services import Services
from app.timeutil import to_local_naive


def get_services(request: Request) -> Services:
    return request.app.state.services


def resolve_location(svc: Services, loc: Location) -> str:
    if isinstance(loc, LatLng):
        return svc.network.nearest_node(loc.lat, loc.lng).id
    if loc not in svc.network.nodes:
        raise HTTPException(404, f"Unknown place {loc!r}. See GET /places.")
    return loc


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(a))


def resolve_place(svc: Services, p: PlaceIn) -> Place:
    """A place id, or a point snapped to the nearest road-map node (remembering how far off)."""
    if p.place is not None:
        node = svc.network.nodes.get(p.place)
        if node is None:
            raise HTTPException(404, f"Unknown place {p.place!r}. See GET /places.")
        return Place(p.name or node.name, node.id, node.lat, node.lng, 0.0)
    node = svc.network.nearest_node(p.lat, p.lng)
    return Place(p.name or node.name, node.id, p.lat, p.lng, haversine_km(p.lat, p.lng, node.lat, node.lng))


def is_clock_time(value: object) -> bool:
    return isinstance(value, str) and len(value) == 5 and value[2] == ":"


MAX_TIME_OFFSET = timedelta(days=366)


def resolve_time(svc: Services, value: datetime | str | None, day: date | None = None) -> datetime:
    """None -> simulated now; 'HH:MM' -> that time on `day` (default: the simulated today); else ISO.
    Anything more than a year from the simulated now is rejected (422)."""
    now = svc.clock.now()
    if value is None:
        return now
    try:
        if isinstance(value, datetime):
            t = to_local_naive(value)
        elif is_clock_time(value):
            hh, mm = map(int, value.split(":"))
            t = datetime.combine(day or now.date(), time(hh, mm))
        else:
            t = to_local_naive(datetime.fromisoformat(value))
    except (ValueError, OverflowError) as e:
        raise HTTPException(422, f"Bad time {value!r}: use ISO or HH:MM") from e
    if abs(t - now) > MAX_TIME_OFFSET:
        raise HTTPException(422, f"Time {value!s} is more than a year from now")
    return t
