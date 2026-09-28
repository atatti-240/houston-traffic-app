"""Search any address or business, and a place's details (hours, phone, website).

Both come from OpenStreetMap through its free geocoder (app/geo/nominatim.py). Our own named
places (GET /places) aren't in here: the app matches those itself and shows them first.
"""

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.api.deps import get_services, resolve_time
from app.geo.hours import hours_json
from app.geo.nominatim import GeoUnavailable, Geocoder, distance_m
from app.services import Services

router = APIRouter(tags=["places"])

ATTRIBUTION = "Place data © OpenStreetMap contributors (ODbL), found with Nominatim"
Lat = Annotated[float | None, Query(ge=-90, le=90)]
Lng = Annotated[float | None, Query(ge=-180, le=180)]


def get_geocoder(request: Request) -> Geocoder:
    """One geocoder per app (it holds the rate limiter and the cache). Tests set their own."""
    geo = getattr(request.app.state, "geocoder", None)
    if geo is None:
        geo = request.app.state.geocoder = Geocoder(get_services(request).session_factory)
    return geo


def _result(r: dict, near: tuple[float, float] | None) -> dict:
    out = {k: r[k] for k in ("id", "name", "address", "lat", "lng", "kind")}
    out["distance_km"] = round(distance_m(near[0], near[1], r["lat"], r["lng"]) / 1000, 2) if near else None
    return out


@router.get("/geocode")
def geocode(
    q: Annotated[str, Query(min_length=3, max_length=120, description="An address or a business name")],
    lat: Lat = None,
    lng: Lng = None,
    limit: Annotated[int, Query(ge=1, le=10)] = 6,
    geo: Geocoder = Depends(get_geocoder),
):
    """Addresses and businesses in the Houston area matching `q`, the ones around `lat`/`lng`
    first. `stale` is true when the geocoder didn't answer and these are older cached results.
    503 when it's down (or busy) and nothing is cached."""
    if not q.strip() or len(q.strip()) < 3:
        raise HTTPException(422, "Type at least 3 letters")
    near = (lat, lng) if lat is not None and lng is not None else None
    try:
        results, stale = geo.search(q, near, limit)
    except GeoUnavailable as e:
        raise HTTPException(503, str(e)) from e
    return {"query": q, "results": [_result(r, near) for r in results], "stale": stale, "attribution": ATTRIBUTION}


@router.get("/geocode/details")
def place_details(
    osm: Annotated[str | None, Query(pattern=r"^[NWR][1-9]\d{0,14}$", description="OpenStreetMap id: N123, W456 or R789")] = None,
    name: Annotated[str | None, Query(min_length=1, max_length=120)] = None,
    lat: Lat = None,
    lng: Lng = None,
    at: datetime | None = None,
    svc: Services = Depends(get_services),
    geo: Geocoder = Depends(get_geocoder),
):
    """A place's details: its OpenStreetMap id (`osm`), or `name` + `lat`/`lng` for a place we
    only know by name. `hours.text` says whether it's open at `at` (default: the app's now,
    Houston time), e.g. "Open now, closes 9 PM"; when the tag is too complex to read, only
    `hours.raw` is set. 404 when OpenStreetMap has nothing on it."""
    try:
        if osm:
            d, stale = geo.place(osm)
        elif name and lat is not None and lng is not None:
            d, stale = geo.find(name, lat, lng)
        else:
            raise HTTPException(422, "Give osm, or name with lat and lng")
    except GeoUnavailable as e:
        raise HTTPException(503, str(e)) from e
    if d is None:
        raise HTTPException(404, "No details for this place")
    t = resolve_time(svc, at)
    return {
        **{k: d[k] for k in ("id", "name", "address", "lat", "lng", "kind", "phone", "website", "brand", "cuisine")},
        "hours": hours_json(d.get("opening_hours"), t),
        "at": t,
        "stale": stale,
        "attribution": ATTRIBUTION,
    }
