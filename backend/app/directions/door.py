"""Door-to-door directions for a route our router picked.

Our router still picks the corridor (it knows traffic, trains and incidents), but it only knows
~80 road segments between interchanges, so a trip to a shop would stop at the nearest one. Here
OSRM draws and describes the whole trip on real roads: from the real start, through points taken
along our chosen segments' traced shapes (each with the direction of travel, so it keeps to the
right carriageway, and as silent via points, so there's no "arrive" at each), to the real end.

A result is checked before we use it (OSRM happily loops round a block, or makes a U-turn, to
reach a via point that snapped onto the wrong side of the road). At most 3 calls, until one passes:

    1. a via point every ~5 km along our roads (at least one per segment)    -> status "ok"
    2. the same without the via that went wrong, or else one per segment   -> status "ok"
    3. OSRM only for the way onto and off our roads, our own line between  -> status "partial"
       (our roads' names as the steps in between)
    4. our line alone, no steps                                            -> status "unavailable"

It never calls OSRM from a loop (recommender, planner): only for the routes we send back.
Results are cached by (rounded endpoints, segment path), they don't depend on the time.

Timing (door_timing): when a trip starts or ends at an arbitrary point, its time is our
traffic-aware time for the part of our corridor it drives + OSRM's time for the way on and off
it. Trips between our named places keep our own time (the place is the door).
"""

import logging
import threading
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from app.directions import geo
from app.directions.osrm import OsrmClient, OsrmError, OsrmUnavailable
from app.directions.steps import build_step, build_steps, corridor_step
from app.graph import SegmentInfo
from app.seed.network import road_shapes

log = logging.getLogger("houston.directions")

VIA_SPACING_M = 5000  # a via point about this often along our roads
NODE_GAP_M = 200  # keep vias this far from interchanges
END_GAP_M = 150  # ... and from where the trip joins / leaves our roads
STRAIGHT_M = 30  # a via on a traced vertex needs this much straight road on each side
STRAIGHT_TURN = 15  # ... turning at most this many degrees
MIN_EDGE_M = 50  # else it sits in the middle of a straight edge at least this long
VIA_RADIUS_M = 30  # via points are on the traced road: snap them only that close
UTURN_NEAR_VIA_M = 300  # a U-turn this close to a via point means the via snapped wrong
VIA_BEARING_RANGE = 45
ACCESS_BEARING_RANGE = 60
MAX_VIAS = 25
SIMPLIFY_M = 4
CACHE_SIZE = 256
BUILD_WAIT_S = 15  # how long a request waits for the same trip's directions being built
MPH = 0.44704  # m/s

# Checks on what OSRM sends back.
CORRIDOR_STRETCH = 1.25  # the part along our roads can be this much longer than our line (+ slack)
CORRIDOR_SLACK_M = 600
CORRIDOR_SHRINK = 0.75  # ... or this much shorter (it cut a corner we didn't mean it to)
ACCESS_STRETCH = 2.5  # the way on / off our roads vs. a straight line (+ slack)
ACCESS_SLACK_M = 1500

UNAVAILABLE_NOTE = "Turn-by-turn directions aren't available right now. The line follows our main roads."
OFF_NOTE = "Turn-by-turn directions are turned off."
PARTIAL_NOTE = "Turn-by-turn covers getting on and off the main roads; follow the highlighted roads in between."


@dataclass(frozen=True)
class Endpoint:
    lat: float
    lng: float
    is_point: bool  # an arbitrary point (a shop, a dropped pin), not one of our places

    @property
    def latlng(self) -> list[float]:
        return [self.lat, self.lng]


@dataclass
class DoorPath:
    """The door-to-door line and steps for one segment path (no times of day in it)."""

    status: str  # ok | partial | unavailable
    geometry: list[list[float]] | None
    steps: list[dict]
    distance_m: float | None
    join_m: float  # where the trip joins our corridor, meters along it
    leave_m: float  # ... and leaves it
    access_start_s: float = 0.0  # OSRM: from the start to join_m
    access_end_s: float = 0.0  # OSRM: from leave_m to the end
    note: str | None = None
    tried: list[str] = field(default_factory=list)


@dataclass
class DoorTiming:
    arrive_at: datetime
    total_s: float
    travel_s: float  # driving, incl. the access legs
    train_delay_s: float
    closure_wait_s: float
    free_flow_s: float
    access_s: float


@dataclass(frozen=True)
class Via:
    d: float  # meters along the corridor
    point: tuple[float, float]
    bearing: int


class Corridor:
    """Our route's roads as one line, with where each segment starts and ends along it.

    Built from the traced road shapes themselves, not the segment lines pinned to our node
    points: a node is an approximate interchange spot that can sit well off the road (the
    I-45 / 610 North node is ~1.7 km from I-45), and following it would send the trip there."""

    def __init__(self, segments: list[SegmentInfo]) -> None:
        self.segments = segments
        self.line: list[list[float]] = []
        self.first_index: list[int] = []
        shapes = road_shapes()["segments"]
        for s in segments:
            pts = [list(p) for p in (shapes.get(s.id) or s.geometry)]
            self.first_index.append(max(0, len(self.line) - 1))
            joined = self.line and geo.dist_m(self.line[-1], pts[0]) < 1
            self.line.extend(pts[1:] if joined else pts)
        self.cum = geo.cumulative(self.line)
        self.bounds: list[tuple[float, float]] = []
        for k in range(len(segments)):
            i, j = self._span(k)
            self.bounds.append((self.cum[i], self.cum[j]))
        self.length = self.cum[-1] if self.cum else 0.0

    def _span(self, k: int) -> tuple[int, int]:
        """First and last vertex of segment k (the first one is shared with the segment before)."""
        return self.first_index[k], self.first_index[k + 1] if k + 1 < len(self.segments) else len(self.line) - 1

    def position(self, p, k: int) -> float:
        """Where p is along the corridor, projected onto segment k."""
        if not self.segments:  # both ends at the same node: no corridor
            return 0.0
        i, j = self._span(k)
        line, cum = self.line[i : j + 1], self.cum[i : j + 1]
        if len(line) < 2:
            return cum[0]
        at, _ = geo.project(p, line, [c - cum[0] for c in cum])
        return cum[0] + at

    def vias(self, d_from: float, d_to: float, spacing: float | None) -> list[Via]:
        """Via points on the traced roads between d_from and d_to, about every `spacing` m (or one
        per segment). Each is the middle of a straight stretch of road (never a corner, where it
        could snap onto the cross street), away from interchanges and from where the trip joins
        or leaves, with the direction of travel so it lands on the right carriageway."""
        out: list[Via] = []
        for k, (s0, s1) in enumerate(self.bounds):
            lo, hi = max(s0 + NODE_GAP_M, d_from + END_GAP_M), min(s1 - NODE_GAP_M, d_to - END_GAP_M)
            if hi <= lo:
                continue
            cands = self._candidates(k, lo, hi)
            if not cands:
                continue
            if spacing is None or hi - lo < spacing:
                targets = [(lo + hi) / 2]
            else:
                n = int((hi - lo) // spacing) + 1
                step = (hi - lo) / n
                targets = [lo + step * (t + 0.5) for t in range(n)]
            picked = {min(cands, key=lambda c: abs(c.d - t)) for t in targets}
            out.extend(sorted(picked, key=lambda v: v.d))
        if len(out) > MAX_VIAS:  # keep the ends, thin the middle
            keep = sorted({round(x * (len(out) - 1) / (MAX_VIAS - 1)) for x in range(MAX_VIAS)})
            out = [out[i] for i in keep]
        return out

    def _candidates(self, k: int, lo: float, hi: float) -> list[Via]:
        """Points of segment k between lo and hi that make good vias: traced vertices (exactly on
        the road) on a straight stretch, else the middle of a long straight edge."""
        i0, i1 = self._span(k)
        line, cum = self.line, self.cum
        out = []
        for i in range(i0 + 1, i1):
            if not lo <= cum[i] <= hi or cum[i] - cum[i - 1] < STRAIGHT_M or cum[i + 1] - cum[i] < STRAIGHT_M:
                continue
            before, after = geo.bearing(line[i - 1], line[i]), geo.bearing(line[i], line[i + 1])
            if geo.angle_diff(before, after) <= STRAIGHT_TURN:
                out.append(Via(cum[i], (line[i][0], line[i][1]), geo.bearing(line[i - 1], line[i + 1])))
        if out:
            return out
        for i in range(i0, i1):
            a, b = line[i], line[i + 1]
            edge = cum[i + 1] - cum[i]
            mid = cum[i] + edge / 2
            if edge >= MIN_EDGE_M and lo <= mid <= hi:
                out.append(Via(mid, ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2), geo.bearing(a, b)))
        return out

    def cut(self, d0: float, d1: float) -> list[list[float]]:
        return geo.cut(self.line, self.cum, d0, d1)


def _line(coords) -> list[list[float]]:
    return [[round(lat, 6), round(lng, 6)] for lng, lat in coords]


def _nearest(line: list[list[float]], p: list[float], start: int = 0) -> int:
    best, at = float("inf"), start
    for i in range(start, len(line)):
        d = geo.dist_m(line[i], p)
        if d < best:
            best, at = d, i
    return at


class Rejected(Exception):
    """OSRM's answer doesn't match our route. `blame`: the vias (indexes) that went wrong."""

    def __init__(self, why: str, blame: set[int] | None = None) -> None:
        super().__init__(why)
        self.blame = blame or set()


class DoorDirections:
    def __init__(self, client: OsrmClient | None = None) -> None:
        self.client = client or OsrmClient()
        self._cache: OrderedDict[tuple, DoorPath] = OrderedDict()
        self._lock = threading.Lock()
        self._building: dict[tuple, threading.Event] = {}  # key -> set when that build is done

    # --- cache ----------------------------------------------------------------------------

    @staticmethod
    def key(segment_ids: list[str], origin: Endpoint, destination: Endpoint) -> tuple:
        r = lambda x: round(x, 4)  # noqa: E731  (~10 m)
        return (r(origin.lat), r(origin.lng), r(destination.lat), r(destination.lng), tuple(segment_ids))

    def cached(self, segments: list[SegmentInfo], origin: Endpoint, destination: Endpoint) -> DoorPath | None:
        with self._lock:
            key = self.key([s.id for s in segments], origin, destination)
            path = self._cache.get(key)
            if path is not None:
                self._cache.move_to_end(key)
            return path

    def _store(self, key: tuple, path: DoorPath) -> None:
        with self._lock:
            self._cache[key] = path
            self._cache.move_to_end(key)
            while len(self._cache) > CACHE_SIZE:
                self._cache.popitem(last=False)

    # --- building -------------------------------------------------------------------------

    def build(self, segments: list[SegmentInfo], origin: Endpoint, destination: Endpoint) -> DoorPath:
        """Door-to-door directions along these segments (cached; may call OSRM). Two requests for
        the same trip at once share one build instead of queueing two OSRM calls."""
        key = self.key([s.id for s in segments], origin, destination)
        with self._lock:
            hit = self._cache.get(key)
            running = self._building.get(key)
            if hit is None and running is None:
                self._building[key] = threading.Event()
        if hit is not None:
            return hit
        if running is not None:
            running.wait(BUILD_WAIT_S)
            return self.cached(segments, origin, destination) or self._unavailable(Corridor(segments), [])
        try:
            return self._build(segments, origin, destination)
        finally:
            with self._lock:
                self._building.pop(key).set()

    def _unavailable(self, corr: "Corridor", tried: list[str]) -> DoorPath:
        note = OFF_NOTE if not self.client.enabled else UNAVAILABLE_NOTE
        return DoorPath("unavailable", None, [], None, 0.0, corr.length, note=note, tried=tried)

    def _build(self, segments: list[SegmentInfo], origin: Endpoint, destination: Endpoint) -> DoorPath:
        corr = Corridor(segments)
        d_from = corr.position(origin.latlng, 0)
        d_to = corr.position(destination.latlng, len(segments) - 1)
        if d_to < d_from:  # a one-segment trip that runs backwards along it: no corridor to follow
            d_from = d_to = (d_from + d_to) / 2

        full = corr.vias(d_from, d_to, VIA_SPACING_M)
        few = corr.vias(d_from, d_to, None)
        # At most 3 OSRM calls: vias; then without the via that went wrong (or one per segment);
        # then only the way on and off our roads.
        attempt: tuple[str, list[Via]] | None = ("vias", full) if full else ("direct", [])
        tried: list[str] = []
        transient = False
        while attempt is not None:
            kind, vias = attempt
            label = f"{kind}:{len(vias)}"
            try:
                path = self._attempt(kind, corr, vias, origin, destination, d_from)
            except OsrmUnavailable as e:
                tried.append(f"{label} unavailable ({e})")
                transient = True
                break
            except (OsrmError, Rejected) as e:
                tried.append(f"{label} rejected ({e})")
                attempt = None
                if kind == "vias":
                    blame = e.blame if isinstance(e, Rejected) else set()
                    kept = [v for i, v in enumerate(vias) if i not in blame]
                    fewer = kept if blame else few
                    if len(tried) == 1 and fewer and len(fewer) < len(vias):
                        attempt = ("vias", fewer)
                    else:
                        ends = kept or vias
                        attempt = ("access", [ends[0], ends[-1]])
                continue
            path.tried = tried + [f"{label} ok"]
            self._store(self.key([s.id for s in segments], origin, destination), path)
            return path

        path = self._unavailable(corr, tried)
        if tried and not transient:  # the same route would be turned down again: remember that
            log.warning("No door-to-door directions for %s: %s", [s.id for s in segments], "; ".join(tried))
            self._store(self.key([s.id for s in segments], origin, destination), path)
        return path

    def _attempt(self, kind: str, corr: Corridor, vias: list[Via], o: Endpoint, d: Endpoint, d_from: float) -> DoorPath:
        if kind == "direct":
            return self._direct(corr, o, d, d_from)
        if kind == "access":
            return self._access(corr, vias, o, d)
        return self._along(corr, vias, o, d)

    def _check_access(self, what: str, meters: float, a, b) -> None:
        limit = ACCESS_STRETCH * geo.dist_m(a, b) + ACCESS_SLACK_M
        if meters > limit:
            raise Rejected(f"way {what} is {meters:.0f} m, expected under {limit:.0f} m")

    def _along(self, corr: Corridor, vias: list[Via], o: Endpoint, d: Endpoint) -> DoorPath:
        """OSRM through via points along our roads, one leg."""
        pts = [o.latlng, *[list(v.point) for v in vias], d.latlng]
        bearings = [None, *[(v.bearing, VIA_BEARING_RANGE) for v in vias], None]
        radiuses = [None, *[VIA_RADIUS_M] * len(vias), None]
        r = self.client.route(pts, bearings, radiuses, via_only=True, annotations=True)
        geom = _line(r["geometry"]["coordinates"])
        leg = r["legs"][0]
        ann = leg.get("annotation") or {}
        durs, dists = ann.get("duration") or [], ann.get("distance") or []
        wps = r.get("waypoints") or []
        if len(wps) != len(pts) or len(durs) != len(geom) - 1:
            raise Rejected("unexpected response shape")
        first = _nearest(geom, [wps[1]["location"][1], wps[1]["location"][0]])
        last = _nearest(geom, [wps[-2]["location"][1], wps[-2]["location"][0]], first)

        corridor_m = vias[-1].d - vias[0].d
        middle_m = sum(dists[first:last])
        if middle_m > CORRIDOR_STRETCH * corridor_m + CORRIDOR_SLACK_M:
            raise Rejected(f"{middle_m:.0f} m along our roads, ours is {corridor_m:.0f} m")
        if middle_m < CORRIDOR_SHRINK * corridor_m - CORRIDOR_SLACK_M:
            raise Rejected(f"only {middle_m:.0f} m along our roads, ours is {corridor_m:.0f} m")
        self._check_access("on", sum(dists[:first]), o.latlng, vias[0].point)
        self._check_access("off", sum(dists[last:]), vias[-1].point, d.latlng)
        snapped = [[w["location"][1], w["location"][0]] for w in wps[1:-1]]
        back = geo.doubles_back(geom[first : last + 1])
        if back is not None:
            at = geom[first + back]
            raise Rejected("doubles back on itself", {min(range(len(vias)), key=lambda i: geo.dist_m(snapped[i], at))})
        # A U-turn at a via point: it snapped onto the wrong side and the route turns back to it.
        # (Other U-turns are how the road network works, e.g. Texas U-turns at frontage roads.)
        for st in leg.get("steps", []):
            m = st.get("maneuver", {})
            if m.get("modifier") == "uturn" and m.get("type") not in ("depart", "arrive"):
                at = [m["location"][1], m["location"][0]]
                near = {i for i, v in enumerate(snapped) if geo.dist_m(at, v) < UTURN_NEAR_VIA_M}
                if near:
                    raise Rejected("U-turn at a via point", near)

        return DoorPath(
            "ok",
            geo.simplify(geom, SIMPLIFY_M),
            build_steps(r["legs"]),
            round(float(r.get("distance", 0.0)), 1),
            vias[0].d,
            vias[-1].d,
            access_start_s=sum(durs[:first]),
            access_end_s=sum(durs[last:]),
        )

    def _access(self, corr: Corridor, vias: list[Via], o: Endpoint, d: Endpoint) -> DoorPath:
        """OSRM only onto and off our roads; our own line (and road names) in between."""
        on, off = vias[0], vias[-1]
        mids = [on] if on == off else [on, off]
        pts = [o.latlng, *[list(v.point) for v in mids], d.latlng]
        bearings = [None, *[(v.bearing, ACCESS_BEARING_RANGE) for v in mids], None]
        radiuses = [None, *[VIA_RADIUS_M * 2] * len(mids), None]
        r = self.client.route(pts, bearings, radiuses)
        legs = r["legs"]
        first, last = legs[0], legs[-1]
        self._check_access("on", first.get("distance", 0.0), o.latlng, on.point)
        self._check_access("off", last.get("distance", 0.0), off.point, d.latlng)

        def leg_line(leg: dict) -> list[list[float]]:
            out: list[list[float]] = []
            for st in leg.get("steps", []):
                pts_ = _line(st.get("geometry", {}).get("coordinates", []))
                out.extend(pts_ if not out else pts_[1:])
            return out

        geom = leg_line(first) + corr.cut(on.d, off.d) + leg_line(last)
        steps = [build_step(st) for st in first.get("steps", []) if st.get("maneuver", {}).get("type") != "arrive"]
        steps += self._corridor_steps(corr, on.d, off.d)
        steps += [build_step(st) for st in last.get("steps", []) if st.get("maneuver", {}).get("type") != "depart"]
        distance = first.get("distance", 0.0) + (off.d - on.d) + last.get("distance", 0.0)
        return DoorPath(
            "partial",
            geo.simplify(geom, SIMPLIFY_M),
            steps,
            round(distance, 1),
            on.d,
            off.d,
            access_start_s=float(first.get("duration", 0.0)),
            access_end_s=float(last.get("duration", 0.0)),
            note=PARTIAL_NOTE,
        )

    def _direct(self, corr: Corridor, o: Endpoint, d: Endpoint, at: float) -> DoorPath:
        """Too short to follow our roads: OSRM from door to door."""
        r = self.client.route([o.latlng, d.latlng])
        limit = 2 * geo.dist_m(o.latlng, d.latlng) + 2000
        if r.get("distance", 0.0) > limit:
            raise Rejected(f"{r.get('distance', 0):.0f} m for a {geo.dist_m(o.latlng, d.latlng):.0f} m hop")
        return DoorPath(
            "ok",
            geo.simplify(_line(r["geometry"]["coordinates"]), SIMPLIFY_M),
            build_steps(r["legs"]),
            round(float(r.get("distance", 0.0)), 1),
            at,
            at,
            access_start_s=float(r.get("duration", 0.0)),
        )

    @staticmethod
    def _corridor_steps(corr: Corridor, d0: float, d1: float) -> list[dict]:
        """One step per road along our corridor between d0 and d1."""
        out: list[dict] = []
        for seg, (s0, s1) in zip(corr.segments, corr.bounds):
            ov = min(d1, s1) - max(d0, s0)
            if ov <= 0:
                continue
            secs = ov / max(1.0, seg.free_flow_mph * MPH)
            if out and out[-1]["road"] == seg.name:
                out[-1]["distance_m"] = round(out[-1]["distance_m"] + ov, 1)
                out[-1]["duration_s"] = round(out[-1]["duration_s"] + secs, 1)
                continue
            where = geo.point_at(corr.line, corr.cum, max(d0, s0))
            out.append(corridor_step(seg.name, where, ov, secs, first=not out))
        return out


def door_timing(route, corr: Corridor, path: DoorPath) -> DoorTiming | None:
    """Time for the door-to-door trip: our traffic-aware time for the part of the corridor it
    drives (train and closure waits included where they fall) + OSRM's way on and off it.
    None when there's nothing to change (no directions)."""
    if path.status == "unavailable":
        return None
    a, b = path.join_m, path.leave_m
    travel = free = train = closure = 0.0
    for k, (s, info, (s0, s1)) in enumerate(zip(route.segments, corr.segments, corr.bounds)):
        length = s1 - s0
        ov = min(b, s1) - max(a, s0)
        if ov <= 0 or length <= 0:
            continue
        f = min(1.0, ov / length)
        travel += s.travel_s * f
        free += info.free_flow_seconds * f
        closure += s.closure_wait_s
        for c in s.crossings:
            if a <= corr.position((c.lat, c.lng), k) <= b:
                train += c.expected_delay_s
    access = path.access_start_s + path.access_end_s
    total = travel + train + closure + access
    return DoorTiming(
        arrive_at=route.depart_at + timedelta(seconds=total),
        total_s=total,
        travel_s=travel + access,
        train_delay_s=train,
        closure_wait_s=closure,
        free_flow_s=free + access,
        access_s=access,
    )
