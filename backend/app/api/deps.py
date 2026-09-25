from datetime import datetime, time

from fastapi import HTTPException, Request

from app.api.schemas import LatLng, Location
from app.services import Services


def get_services(request: Request) -> Services:
    return request.app.state.services


def resolve_location(svc: Services, loc: Location) -> str:
    if isinstance(loc, LatLng):
        return svc.network.nearest_node(loc.lat, loc.lng).id
    if loc not in svc.network.nodes:
        raise HTTPException(404, f"Unknown place {loc!r}. See GET /places.")
    return loc


def resolve_time(svc: Services, value: datetime | str | None) -> datetime:
    """None -> simulated now; 'HH:MM' -> today at that time (simulated date); else ISO."""
    now = svc.clock.now()
    if value is None:
        return now
    if isinstance(value, datetime):
        return value.replace(tzinfo=None)
    try:
        if len(value) == 5 and value[2] == ":":
            hh, mm = map(int, value.split(":"))
            return datetime.combine(now.date(), time(hh, mm))
        return datetime.fromisoformat(value).replace(tzinfo=None)
    except ValueError as e:
        raise HTTPException(422, f"Bad time {value!r}: use ISO or HH:MM") from e
