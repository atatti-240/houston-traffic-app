"""Walking and cycling directions from the FOSSGIS OpenStreetMap routers (routing.openstreetmap.de).

The URL is built here from two validated points, never from user text. Answers are cached,
requests are spaced a second apart (a public server), every call has a timeout, and a server
that is down, slow or busy becomes RoutingUnavailable, which the API turns into a clear message.
"""

import http.client
import json
import math
import threading
import time
import urllib.error
import urllib.request
from collections import OrderedDict
from collections.abc import Callable
from typing import Literal

Mode = Literal["walk", "bike"]

BASE_URL = "https://routing.openstreetmap.de"
PROFILES: dict[str, str] = {"walk": "routed-foot", "bike": "routed-bike"}
USER_AGENT = "BlindSpot/0.1 (Houston traffic app; https://github.com/atatti-240/houston-traffic-app)"
SOURCE = "Map data (c) OpenStreetMap contributors, routing by FOSSGIS (routing.openstreetmap.de)"
TIMEOUT_S = 10
MIN_INTERVAL_S = 1.0  # at most one request a second
MAX_WAIT_S = 4.0  # rather than queue longer than this, say it's busy
CACHE_SIZE = 256
CACHE_TTL_S = 3600
# Greater Houston: points outside aren't ours to route.
BOUNDS = (29.2, 30.4, -96.1, -94.7)  # min lat, max lat, min lng, max lng
# Farther than this in a straight line isn't a walk or a ride we'd suggest.
MAX_KM: dict[str, float] = {"walk": 15.0, "bike": 50.0}

Fetch = Callable[[str], dict]


class RoutingUnavailable(Exception):
    """The routing server is down, slow, busy or answered something we can't read."""


class NoRoute(Exception):
    """The server answered, but there's no way between the two points."""


class BadRequest(ValueError):
    """Points outside the area, or too far apart for this mode."""


def http_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        # OSRM answers "no route" style errors as 400 with a JSON body.
        if e.code == 400:
            try:
                return json.load(e)
            except ValueError:
                pass
        raise


def distance_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(h))


def check_points(a: tuple[float, float], b: tuple[float, float]) -> None:
    lo_lat, hi_lat, lo_lng, hi_lng = BOUNDS
    for lat, lng in (a, b):
        if not (math.isfinite(lat) and math.isfinite(lng) and lo_lat <= lat <= hi_lat and lo_lng <= lng <= hi_lng):
            raise BadRequest("That's outside the Houston area BlindSpot covers.")


def route_url(mode: Mode, a: tuple[float, float], b: tuple[float, float]) -> str:
    # The path's profile segment stays "driving": each FOSSGIS server routes for its own profile.
    return (
        f"{BASE_URL}/{PROFILES[mode]}/route/v1/driving/{a[1]:.6f},{a[0]:.6f};{b[1]:.6f},{b[0]:.6f}"
        "?overview=full&geometries=geojson&steps=true"
    )


# ---- turn-by-turn text -----------------------------------------------------------------------------

_TURN = {"slight left": "slightly left", "slight right": "slightly right"}
_SIDE = {"left": "left", "slight left": "left", "sharp left": "left", "right": "right", "slight right": "right", "sharp right": "right"}
_COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"]


def _ordinal(n: int) -> str:
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def instruction(step: dict) -> str:
    """One OSRM step in plain words: "Turn left onto Westheimer Road"."""
    m = step.get("maneuver", {})
    kind, mod = m.get("type", ""), m.get("modifier", "")
    name = (step.get("name") or step.get("ref") or "").strip()
    onto = f" onto {name}" if name else ""
    if step.get("mode") == "ferry":
        return f"Take the ferry{f' ({name})' if name else ''}"
    if kind == "depart":
        heading = _COMPASS[round((m.get("bearing_after") or 0) / 45) % 8]
        return f"Head {heading}{f' on {name}' if name else ''}"
    if kind == "arrive":
        side = _SIDE.get(mod)
        return f"Arrive, on the {side}" if side else "Arrive"
    if kind in ("roundabout", "rotary", "roundabout turn"):
        n = m.get("exit")
        return f"At the roundabout, take the {_ordinal(n)} exit{onto}" if n else f"Go around the roundabout{onto}"
    if kind in ("exit roundabout", "exit rotary"):
        return f"Leave the roundabout{onto}"
    if mod == "uturn":
        return f"Turn around{onto}"
    if kind == "fork":
        return f"Keep {_SIDE[mod]} at the fork{onto}" if mod in _SIDE else f"Continue at the fork{onto}"
    if kind == "end of road" and mod in _SIDE:
        return f"Turn {_SIDE[mod]} at the end of the road{onto}"
    if kind in ("on ramp", "off ramp", "merge"):
        return f"Take the ramp{onto}" if kind != "merge" else f"Merge{onto}"
    if mod in ("", "straight"):
        return f"Continue{onto}" if name else "Continue straight"
    return f"Turn {_TURN.get(mod, mod)}{onto}"


MIN_STEP_M = 30  # shorter steps (crossing a street, a jog in the path) fold into the next one
_KEEP = ("depart", "arrive", "roundabout", "rotary", "roundabout turn", "exit roundabout", "exit rotary")


def _angle(before: float, after: float) -> float:
    """Signed change of bearing, -180..180 (positive = to the right)."""
    return (after - before + 540) % 360 - 180


def _merged_turn(before: float, after: float, turned: float) -> str:
    """The modifier for a turn folded together from several: its size from where you face before and
    after, its side from the turns themselves when that's near 180 degrees. Never a U-turn: two turns
    the same way round a block read better as a sharp turn."""
    d = _angle(before, after)
    if abs(d) > 150 and turned:
        d = math.copysign(abs(d), turned)
    side = "right" if d > 0 else "left"
    a = abs(d)
    if a < 20:
        return "straight"
    if a < 50:
        return f"slight {side}"
    return side if a < 120 else f"sharp {side}"


def simple_steps(legs: list[dict]) -> list[dict]:
    """OSRM's steps, simplified: a short jog folds into the next step (which then turns by the net
    change of direction), and "continue straight on the same street" folds into the step before."""
    raw = [st for leg in legs for st in leg.get("steps", [])]
    steps: list[dict] = []
    carry: tuple[float, float, float, float] | None = None  # distance, duration, bearing before, turned so far
    for i, st in enumerate(raw):
        m = dict(st.get("maneuver", {}))
        st = {**st, "maneuver": m}
        turned = _angle(m.get("bearing_before", 0), m.get("bearing_after", 0))
        if carry is not None:
            st["distance"] = st.get("distance", 0) + carry[0]
            st["duration"] = st.get("duration", 0) + carry[1]
            turned += carry[3]
            m["modifier"] = _merged_turn(carry[2], m.get("bearing_after", carry[2]), turned)
            m["type"] = "continue" if m["modifier"] == "straight" else "turn"
            m["bearing_before"] = carry[2]
            carry = None
        nxt = raw[i + 1]["maneuver"].get("type") if i + 1 < len(raw) else None
        if m.get("type") not in _KEEP and st.get("distance", 0) < MIN_STEP_M and nxt is not None and nxt not in _KEEP:
            carry = (st.get("distance", 0), st.get("duration", 0), m.get("bearing_before", 0), turned)
            continue
        steps.append(st)

    out: list[dict] = []
    for st in steps:
        m = st["maneuver"]
        kind, mod = m.get("type", ""), m.get("modifier", "")
        name = (st.get("name") or st.get("ref") or "").strip()
        if (
            out
            and kind in ("new name", "continue", "notification", "use lane", "turn")
            and mod in ("", "straight", *(("slight left", "slight right") if kind != "turn" else ()))
            and (name == out[-1]["name"] or not name)
        ):
            out[-1]["distance_m"] += round(st.get("distance", 0))
            out[-1]["duration_s"] += round(st.get("duration", 0))
            continue
        lng, lat = m.get("location", [0.0, 0.0])
        text = instruction(st)
        if st.get("mode") == "pushing bike":
            text += " (walk your bike)"
        out.append(
            {
                "instruction": text,
                "name": name,
                "type": kind,
                "modifier": mod or None,
                "distance_m": round(st.get("distance", 0)),
                "duration_s": round(st.get("duration", 0)),
                "at": [round(lat, 6), round(lng, 6)],
            }
        )
    return out


def parse_route(mode: Mode, body: dict) -> dict:
    code = body.get("code")
    if code in ("NoRoute", "NoSegment"):
        raise NoRoute(body.get("message") or code)
    if code != "Ok" or not body.get("routes"):
        raise RoutingUnavailable(f"routing server said {code!r}: {body.get('message', '')}")
    r = body["routes"][0]
    coords = r.get("geometry", {}).get("coordinates", [])
    if len(coords) < 2:
        raise RoutingUnavailable("routing server sent no route line")
    return {
        "mode": mode,
        "distance_m": round(r["distance"]),
        "duration_s": round(r["duration"]),
        "geometry": [[round(lat, 6), round(lng, 6)] for lng, lat in coords],
        "steps": simple_steps(r.get("legs", [])),
        "source": SOURCE,
    }


class _Pending:
    """A request on its way: the same question asked meanwhile waits for its answer."""

    def __init__(self) -> None:
        self.done = threading.Event()
        self.result: dict = {}
        self.error: Exception | None = None

    def wait(self) -> dict:
        if not self.done.wait(MAX_WAIT_S + TIMEOUT_S + 1):
            raise RoutingUnavailable("still waiting for the same directions")
        if self.error is not None:
            raise self.error
        return self.result


class WalkBikeRouter:
    """Cached, rate-limited access to the walk and bike routers. `fetch` is swappable for tests."""

    def __init__(self, fetch: Fetch = http_json, clock: Callable[[], float] = time.monotonic, sleep: Callable[[float], None] = time.sleep) -> None:
        self._fetch = fetch
        self._clock = clock
        self._sleep = sleep
        self._lock = threading.Lock()
        self._next_slot = 0.0
        self._cache: OrderedDict[tuple, tuple[float, dict]] = OrderedDict()
        self._pending: dict[tuple, _Pending] = {}

    def route(self, mode: Mode, a: tuple[float, float], b: tuple[float, float]) -> dict:
        if mode not in PROFILES:
            raise BadRequest(f"Unknown mode {mode!r}")
        check_points(a, b)
        km = distance_km(a, b)
        if km > MAX_KM[mode]:
            what = "walk" if mode == "walk" else "bike ride"
            raise BadRequest(f"That's too far for a {what} ({km * 0.621371:.0f} mi in a straight line).")
        key = (mode, round(a[0], 5), round(a[1], 5), round(b[0], 5), round(b[1], 5))
        hit = self._cached(key)
        if hit is not None:
            return hit
        with self._lock:
            other = self._pending.get(key)
            mine = self._pending.setdefault(key, _Pending())
        if other is not None:
            return other.wait()
        try:
            mine.result = self._ask(mode, a, b, key)
            return mine.result
        except Exception as e:
            mine.error = e
            raise
        finally:
            with self._lock:
                self._pending.pop(key, None)
            mine.done.set()

    def _ask(self, mode: Mode, a: tuple[float, float], b: tuple[float, float], key: tuple) -> dict:
        self._wait_turn()
        try:
            body = self._fetch(route_url(mode, a, b))
        except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError) as e:
            raise RoutingUnavailable(str(e)) from e
        result = parse_route(mode, body)
        with self._lock:
            self._cache[key] = (self._clock(), result)
            while len(self._cache) > CACHE_SIZE:
                self._cache.popitem(last=False)
        return result

    def _cached(self, key: tuple) -> dict | None:
        with self._lock:
            hit = self._cache.get(key)
            if hit is None:
                return None
            if self._clock() - hit[0] > CACHE_TTL_S:
                del self._cache[key]
                return None
            self._cache.move_to_end(key)
            return hit[1]

    def _wait_turn(self) -> None:
        """Take the next free slot (one a second); refuse if that's too far off."""
        with self._lock:
            now = self._clock()
            slot = max(now, self._next_slot)
            if slot - now > MAX_WAIT_S:
                raise RoutingUnavailable("too many directions requests right now")
            self._next_slot = slot + MIN_INTERVAL_S
        if slot > now:
            self._sleep(slot - now)


_default: WalkBikeRouter | None = None


def default_router() -> WalkBikeRouter:
    global _default
    if _default is None:
        _default = WalkBikeRouter()
    return _default
