"""Find any address or business around Houston with OpenStreetMap's free geocoder, Nominatim.

The public server's rules (https://operations.osmfoundation.org/policies/nominatim/): at most
one request per second for the whole app, a User-Agent that says who we are, and cache what you
get. So every call here goes through one rate limiter and a cache (in memory, and in SQLite so
answers survive a restart). When the server is slow or down, an older cached answer is better
than nothing; without one the caller gets GeoUnavailable and the app says search is down.

Search asks around you first (a box about 5 km each way), then the whole Houston area when
that finds little. Results come with the place's OpenStreetMap tags (hours, phone, website),
which are cached per place too, so opening a result's card doesn't ask again.
"""

import json
import logging
import math
import re
import threading
import time
import urllib.parse
import urllib.request
from collections import OrderedDict
from collections.abc import Callable
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.models import GeoCache

log = logging.getLogger("houston.geo")

USER_AGENT = "BlindSpot/1.0 (Houston hackathon app)"
TIMEOUT_S = 6.0
MIN_INTERVAL_S = 1.0
# A request that would wait longer than this for its turn gets "busy" instead of hanging.
MAX_WAIT_S = 4.0
# Greater Houston (Katy to Baytown, The Woodlands to Galveston Bay): left, top, right, bottom.
HOUSTON_VIEWBOX = (-96.1, 30.4, -94.7, 29.2)
NEAR_DEG = 0.05
# Asked for per search (then cut to the caller's limit, closest first).
NEAR_FETCH = 15
# Enough results near you: don't ask the whole area too.
NEAR_ENOUGH = 3
# Nominatim's importance for a well-known place (roughly: it has a Wikipedia article).
LANDMARK = 0.1
SEARCH_TTL = timedelta(days=1)
PLACE_TTL = timedelta(days=7)
MISS_TTL = timedelta(hours=1)
MEMORY_ITEMS = 500
# A map dot looked up by name: the match must be this close to where it was tapped.
FIND_BOX_DEG = 0.004
FIND_MAX_M = 350

DOWN = "Search is down right now. Try again in a minute."
BUSY = "Search is busy right now. Try again in a moment."

Fetch = Callable[[str], object]


class GeoUnavailable(Exception):
    """The geocoder didn't answer (down, slow, busy) and nothing usable was cached."""


def http_json(url: str) -> object:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Language": "en"})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
        return json.load(r)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class RateLimiter:
    """At most one call per `interval` seconds across all threads. Each caller takes the next
    free slot and sleeps until it comes; one that would wait more than `max_wait` is refused."""

    def __init__(self, interval: float = MIN_INTERVAL_S, max_wait: float = MAX_WAIT_S,
                 clock: Callable[[], float] = time.monotonic, sleep: Callable[[float], None] = time.sleep) -> None:
        self.interval, self.max_wait = interval, max_wait
        self._clock, self._sleep = clock, sleep
        self._next = 0.0
        self._lock = threading.Lock()

    def wait(self) -> None:
        with self._lock:
            now = self._clock()
            slot = max(now, self._next)
            if slot - now > self.max_wait:
                raise GeoUnavailable(BUSY)
            self._next = slot + self.interval
        if slot > now:
            self._sleep(slot - now)


class Cache:
    """Key -> (value, fetched_at): an LRU in memory in front of the geo_cache table."""

    def __init__(self, session_factory: sessionmaker[Session] | None = None, size: int = MEMORY_ITEMS) -> None:
        self.session_factory, self.size = session_factory, size
        self._mem: OrderedDict[str, tuple[object, datetime]] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: str) -> tuple[object, datetime] | None:
        with self._lock:
            if key in self._mem:
                self._mem.move_to_end(key)
                return self._mem[key]
        if self.session_factory is None:
            return None
        try:
            with self.session_factory() as s:
                row = s.get(GeoCache, key)
                hit = (row.value, row.fetched_at) if row else None
        except Exception:  # the cache is a nice-to-have: never fail a request over it
            log.exception("geo cache read failed")
            return None
        if hit:
            self._remember(key, hit)
        return hit

    def put(self, key: str, value: object, at: datetime) -> None:
        self._remember(key, (value, at))
        if self.session_factory is None:
            return
        try:
            with self.session_factory() as s:
                s.merge(GeoCache(key=key, value=value, fetched_at=at))
                s.commit()
        except Exception:
            log.exception("geo cache write failed")

    def _remember(self, key: str, hit: tuple[object, datetime]) -> None:
        with self._lock:
            self._mem[key] = hit
            self._mem.move_to_end(key)
            while len(self._mem) > self.size:
                self._mem.popitem(last=False)


# ---- turning Nominatim's answers into ours ----------------------------------------------------

KIND = {
    "fuel": "Gas station",
    "charging_station": "EV charging",
    "parking": "Parking",
    "fast_food": "Fast food",
    "house": "Address",
    "yes": "Building",
    "residential": "Street",
    "primary": "Street",
    "secondary": "Street",
    "tertiary": "Street",
    "motorway": "Freeway",
    "trunk": "Highway",
    "suburb": "Neighborhood",
    "neighbourhood": "Neighborhood",
    "city": "City",
    "town": "Town",
    "aerodrome": "Airport",
    "supermarket": "Grocery store",
    "doctors": "Doctor",
}


def humanize(value: str | None) -> str | None:
    if not value:
        return None
    first = value.split(";")[0].strip()
    return first.replace("_", " ").capitalize() if first else None


def kind_of(r: dict) -> str:
    t = r.get("type") or ""
    if r.get("category") == "highway" and t not in KIND:
        return "Street"
    return KIND.get(t) or humanize(t) or humanize(r.get("category")) or "Place"


def osm_ref(r: dict) -> str | None:
    kind, oid = (r.get("osm_type") or "")[:1].upper(), r.get("osm_id")
    return f"{kind}{oid}" if kind in ("N", "W", "R") and oid else None


def place_json(r: dict) -> dict:
    """A search result: name, a short address line and the point."""
    a = r.get("address") or {}
    street = " ".join(x for x in (a.get("house_number"), a.get("road")) if x)
    area = a.get("neighbourhood") or a.get("suburb") or a.get("quarter") or a.get("city_district")
    city = a.get("city") or a.get("town") or a.get("village") or a.get("hamlet")
    name = (r.get("name") or "").strip() or street or (r.get("display_name") or "").split(",")[0].strip() or "Place"
    parts = [p for p in (street if street != name else None, area if area != name else None) if p]
    if city and city != "Houston" and city not in parts and city != name:
        parts.append(city)
    if not parts and city and city != name:
        parts.append(city)
    return {
        "id": osm_ref(r),
        "name": name,
        "address": ", ".join(parts) or None,
        "lat": float(r["lat"]),
        "lng": float(r["lon"]),
        "kind": kind_of(r),
        "importance": float(r.get("importance") or 0),
    }


def clean_url(value: str | None) -> str | None:
    """A website we're happy to link to: http(s) only, with a real host name."""
    if not value:
        return None
    v = value.split(";")[0].strip()
    if not v or re.search(r"[\s<>\"']", v):
        return None
    if not re.match(r"^[a-z][a-z0-9+.-]*://", v, re.I):
        if not re.match(r"^[\w-]+(\.[\w-]+)+(/|$)", v):
            return None
        v = f"https://{v}"
    try:
        p = urllib.parse.urlsplit(v)
    except ValueError:
        return None
    host = p.hostname or ""
    if p.scheme.lower() not in ("http", "https") or "." not in host or p.username or p.password:
        return None
    return v


def clean_phone(value: str | None) -> dict | None:
    """{"display": "(713) 522-3029", "tel": "+17135223029"}, or None when it isn't a phone number."""
    if not value:
        return None
    v = value.split(";")[0].strip()
    digits = re.sub(r"\D", "", v)
    if not 7 <= len(digits) <= 15:
        return None
    if len(digits) == 10 and not v.startswith("+"):
        digits = f"1{digits}"
    if not v.startswith("+") and len(digits) != 11:
        return {"display": v, "tel": digits}
    if len(digits) == 11 and digits.startswith("1"):
        return {"display": f"({digits[1:4]}) {digits[4:7]}-{digits[7:]}", "tel": f"+{digits}"}
    return {"display": v, "tel": f"+{digits}"}


def details_json(r: dict) -> dict:
    """A place with what OpenStreetMap knows about it (no ratings: OSM has none)."""
    t = r.get("extratags") or {}
    return {
        **place_json(r),
        "phone": clean_phone(t.get("phone") or t.get("contact:phone")),
        "website": clean_url(t.get("website") or t.get("contact:website") or t.get("url")),
        "opening_hours": (t.get("opening_hours") or "").strip() or None,
        "brand": t.get("brand"),
        "cuisine": humanize(t.get("cuisine")),
    }


def distance_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6_371_000 * math.asin(math.sqrt(a))


class Geocoder:
    def __init__(
        self,
        session_factory: sessionmaker[Session] | None = None,
        fetch: Fetch = http_json,
        base_url: str | None = None,
        limiter: RateLimiter | None = None,
        now: Callable[[], datetime] = _utcnow,
    ) -> None:
        self.base_url = (base_url or settings.nominatim_url).rstrip("/")
        self.fetch, self.now = fetch, now
        self.limiter = limiter or RateLimiter()
        self.cache = Cache(session_factory)

    # ---- plumbing ---------------------------------------------------------------------------

    def _url(self, path: str, **params: object) -> str:
        base = {"format": "jsonv2", "addressdetails": 1, "extratags": 1}
        return f"{self.base_url}/{path}?{urllib.parse.urlencode({**base, **params})}"

    def _get(self, key: str, url: str, ttl: timedelta, parse: Callable[[object], object]) -> tuple[object, bool]:
        """(value, stale): the cached value while fresh, else ask (then cache). If asking fails,
        an expired cached value comes back with stale=True, else GeoUnavailable."""
        hit = self.cache.get(key)
        if hit is not None:
            value, at = hit
            if self.now() - at < (ttl if value not in (None, []) else MISS_TTL):
                return value, False
        try:
            self.limiter.wait()
            value = parse(self.fetch(url))
        except GeoUnavailable:
            if hit is not None:
                return hit[0], True
            raise
        except Exception as e:  # timeouts, HTTP errors, bad JSON: all mean "down" to the user
            log.warning("geocoder failed (%s): %s", url, e)
            if hit is not None:
                return hit[0], True
            raise GeoUnavailable(DOWN) from e
        self.cache.put(key, value, self.now())
        return value, False

    def _results(self, data: object) -> list[dict]:
        """Search results, each also cached as its place's details (same tags)."""
        if not isinstance(data, list):
            raise ValueError("unexpected answer")
        out, now = [], self.now()
        for r in data:
            if not isinstance(r, dict) or "lat" not in r:
                continue
            d = details_json(r)
            if d["id"]:
                self.cache.put(f"place|{d['id']}", d, now)
            out.append(d)
        return out

    def _search(self, q: str, box: tuple[float, float, float, float], key: str, limit: int) -> tuple[list[dict], bool]:
        url = self._url("search", q=q, limit=limit, viewbox=",".join(f"{v:.4f}" for v in box), bounded=1, countrycodes="us")
        return self._get(key, url, SEARCH_TTL, self._results)  # type: ignore[return-value]

    # ---- what the API uses ------------------------------------------------------------------

    def search(self, q: str, near: tuple[float, float] | None = None, limit: int = 6) -> tuple[list[dict], bool]:
        """Places matching `q` in the Houston area, the ones around `near` first. (results, stale)

        Near you, the geocoder ranks a chain's branches all the same, so we ask for more of them
        and keep the closest; well-known places (a university, the airport) stay on top."""
        q = " ".join(q.split())
        norm = q.lower()
        results: list[dict] = []
        stale = False
        if near:
            lat, lng = near
            box = (lng - NEAR_DEG, lat + NEAR_DEG, lng + NEAR_DEG, lat - NEAR_DEG)
            results, stale = self._search(q, box, f"search|{norm}|{lat:.2f},{lng:.2f}", NEAR_FETCH)
        if len(results) < NEAR_ENOUGH:
            try:
                more, more_stale = self._search(q, HOUSTON_VIEWBOX, f"search|{norm}|houston", NEAR_FETCH)
            except GeoUnavailable:
                if not near:
                    raise
                more, more_stale = [], True  # keep what we found near you
            seen = {r["id"] for r in results}
            results = results + [r for r in more if r["id"] not in seen]
            stale = stale or more_stale
        if near:
            results = sorted(
                results,
                key=lambda r: (r.get("importance", 0) < LANDMARK, distance_m(near[0], near[1], r["lat"], r["lng"])),
            )
        return results[:limit], stale

    def place(self, osm: str) -> tuple[dict | None, bool]:
        """Details for an OpenStreetMap object ("N123", "W456", "R789")."""

        def first(data: object) -> dict | None:
            items = self._results(data)
            return items[0] if items else None

        return self._get(f"place|{osm}", self._url("lookup", osm_ids=osm), PLACE_TTL, first)  # type: ignore[return-value]

    def find(self, name: str, lat: float, lng: float) -> tuple[dict | None, bool]:
        """Details for a named place at a point (a map dot we have no OpenStreetMap id for)."""
        name = " ".join(name.split())
        box = (lng - FIND_BOX_DEG, lat + FIND_BOX_DEG, lng + FIND_BOX_DEG, lat - FIND_BOX_DEG)

        def nearest(data: object) -> dict | None:
            close = [(distance_m(lat, lng, r["lat"], r["lng"]), r) for r in self._results(data)]
            close = [c for c in close if c[0] <= FIND_MAX_M]
            return min(close, key=lambda c: c[0])[1] if close else None

        url = self._url("search", q=name, limit=5, viewbox=",".join(f"{v:.5f}" for v in box), bounded=1)
        return self._get(f"find|{name.lower()}|{lat:.4f},{lng:.4f}", url, PLACE_TTL, nearest)  # type: ignore[return-value]
