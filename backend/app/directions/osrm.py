"""A small client for the public OSRM router (OpenStreetMap roads, no key).

Polite and safe to call from a request:
  - at most one request per second from this process (the public server's policy),
  - a short timeout on every call,
  - after a network error, a timeout or an overloaded server it stops asking for a minute
    and fails fast, so a slow or dead server never makes the app hang,
  - OSRM_URL="" turns it off (the tests do that: they never touch the network).

Road data (c) OpenStreetMap contributors, ODbL.
"""

import http.client
import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Sequence

log = logging.getLogger("houston.osrm")

DEFAULT_URL = "https://router.project-osrm.org"
USER_AGENT = "BlindSpot-Houston/0.1 (traffic app; door-to-door directions)"

# fetch(url, timeout) -> (HTTP status, parsed JSON body). Raises OSError / ValueError on failure.
Fetch = Callable[[str, float], tuple[int, dict]]


class OsrmError(Exception):
    """OSRM couldn't answer this request."""


class OsrmUnavailable(OsrmError):
    """Turned off, down, slow, busy or rate limited: try again later."""


class OsrmNoRoute(OsrmError):
    """OSRM answered, but not with a route (e.g. a point it can't snap to a road)."""


def urllib_fetch(url: str, timeout: float) -> tuple[int, dict]:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:  # OSRM explains a 400 in a JSON body
        try:
            return e.code, json.load(e)
        except ValueError:
            return e.code, {}


class OsrmClient:
    def __init__(
        self,
        base_url: str | None = None,
        fetch: Fetch | None = None,
        min_interval: float = 1.0,
        timeout: float = 4.0,
        cooldown: float = 60.0,
        max_wait: float = 2.0,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.base_url = (base_url if base_url is not None else os.environ.get("OSRM_URL", DEFAULT_URL)).rstrip("/")
        self.fetch = fetch or urllib_fetch
        self.min_interval = min_interval
        self.timeout = timeout
        self.cooldown = cooldown
        self.max_wait = max_wait
        self.clock = clock
        self.sleep = sleep
        self._lock = threading.Lock()
        self._next_at = 0.0  # earliest start of the next request
        self._down_until = 0.0
        self.calls = 0  # requests actually sent (for tests and logs)

    @property
    def enabled(self) -> bool:
        return bool(self.base_url)

    @property
    def down(self) -> bool:
        return self.clock() < self._down_until

    def _slot(self) -> None:
        """Wait for our turn (one request per min_interval), or give up if the queue is long."""
        with self._lock:
            now = self.clock()
            if now < self._down_until:
                raise OsrmUnavailable("OSRM is cooling down after a failure")
            wait = self._next_at - now
            if wait > self.max_wait:
                raise OsrmUnavailable("OSRM is busy")
            self._next_at = max(now, self._next_at) + self.min_interval
        if wait > 0:
            self.sleep(wait)

    def _trip(self, why: str, seconds: float | None = None) -> None:
        with self._lock:
            self._down_until = self.clock() + (self.cooldown if seconds is None else seconds)
        log.warning(
            "OSRM unavailable (%s); not asking again for %.0f s", why, self.cooldown if seconds is None else seconds
        )

    def route(
        self,
        points: Sequence[Sequence[float]],
        bearings: Sequence[tuple[int, int] | None] | None = None,
        radiuses: Sequence[float | None] | None = None,
        via_only: bool = False,
        annotations: bool = False,
    ) -> dict:
        """Driving route through `points` ([lat, lng]) with steps and full GeoJSON geometry.
        `via_only`: the points between the first and the last are silent via points (one leg, no
        "arrive" at each). Returns the first route; raises OsrmError subclasses."""
        if not self.enabled:
            raise OsrmUnavailable("OSRM is turned off")
        if len(points) < 2:
            raise OsrmNoRoute("need at least two points")
        coords = ";".join(f"{p[1]:.6f},{p[0]:.6f}" for p in points)
        params = ["overview=full", "geometries=geojson", "steps=true", "continue_straight=true"]
        if annotations:
            params.append("annotations=duration,distance")
        if via_only and len(points) > 2:
            params.append(f"waypoints=0;{len(points) - 1}")
        if bearings:
            params.append("bearings=" + ";".join(f"{b[0]},{b[1]}" if b else "" for b in bearings))
        if radiuses:
            params.append("radiuses=" + ";".join(f"{r:g}" if r else "unlimited" for r in radiuses))
        url = f"{self.base_url}/route/v1/driving/{coords}?{'&'.join(params)}"

        self._slot()
        self.calls += 1
        started = self.clock()
        try:
            status, body = self.fetch(url, self.timeout)
        except (OSError, ValueError, http.client.HTTPException) as e:  # refused, DNS, timeout, cut off, bad JSON
            self._trip(type(e).__name__)
            raise OsrmUnavailable(str(e) or type(e).__name__) from e
        if status == 429:
            self._trip("rate limited", 10.0)
            raise OsrmUnavailable("OSRM rate limited us")
        if status >= 500:
            self._trip(f"HTTP {status}")
            raise OsrmUnavailable(f"OSRM HTTP {status}")
        code = body.get("code")
        if code != "Ok" or not body.get("routes"):
            raise OsrmNoRoute(f"{code or status}: {body.get('message', '')}".strip())
        log.info("OSRM route: %d points in %.2f s", len(points), self.clock() - started)
        route = body["routes"][0]
        route["waypoints"] = body.get("waypoints", [])
        return route
