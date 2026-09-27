"""Transit trips on METRO's scheduled timetable: walk to a stop, ride a bus or train (directly, or
with one change), walk to where you're going. Plus the next departures from the stops near you.

Reads the index built by app/travel/gtfs.py (`make transit`). Times are scheduled times in the
app's naive Houston local time (the feed's own timezone); there's no live bus tracking. With no
index, or a day the timetable doesn't cover, the answer says so instead of guessing.

The search looks at every trip leaving a stop near the start in the next 90 minutes and every
trip reaching a stop near the destination, and joins them where one passes (or stops within a
short walk of) the other. Walks are estimated from the straight-line distance.
"""

import bisect
import json
import logging
import math
import os
import re
import sqlite3
import threading
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from pathlib import Path

from app.config import BACKEND_DIR
from app.travel.gtfs import NO_DROP_OFF, NO_PICKUP, SCHEMA_VERSION, service_range

log = logging.getLogger("houston")

DEFAULT_PATH = Path(os.environ.get("TRANSIT_DB", str(BACKEND_DIR / "data" / "transit.db")))
LEGEND = "Route and arrival data provided by permission of METRO"

WALK_MPS = 1.3  # walking speed
WALK_DETOUR = 1.3  # a walk along the streets vs. the straight line
MAX_ACCESS_M = 1000  # straight line to a stop at either end (about a 17-minute walk)
FAR_ACCESS_M = 1600  # when there's none that close (about 27 minutes)
MAX_STOPS_PER_END = 40
CHANGE_M = 250  # walk between stops when changing (straight line)
MIN_CHANGE_S = 120  # time to change on top of that walk
BOARD_WINDOW_S = 90 * 60  # leave on a first ride within 90 minutes
HORIZON_S = 4 * 3600  # and arrive within 4 hours
CHANGE_PENALTY_S = 5 * 60  # how much a change counts against an option
MAX_OPTIONS = 3
MAX_LATER = 2
NEARBY_STOPS = 3
NEARBY_WINDOW_S = 3600


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6_371_000 * math.asin(math.sqrt(h))


def walk_s(meters: float) -> float:
    return meters * WALK_DETOUR / WALK_MPS


def walk_min(meters: float) -> int:
    """Whole minutes (at least 1), so shown times add up."""
    return max(1, math.ceil(walk_s(meters) / 60))


def _day(d: date) -> str:
    return f"{d:%a} {d:%b} {d.day}"


def _long_day(d: date) -> str:
    return f"{d:%b} {d.day}, {d.year}"


@dataclass(frozen=True)
class Stop:
    id: int
    gtfs_id: str
    code: str
    name: str
    lat: float
    lng: float


@dataclass(frozen=True)
class Route:
    id: int
    gtfs_id: str
    short_name: str
    long_name: str
    type: int
    color: str
    text_color: str

    @property
    def mode(self) -> str:
        return "bus" if self.type == 3 else "rail" if self.type in (0, 1, 2, 12) else "transit"

    @property
    def label(self) -> str:
        """"82 Westheimer", "Red Line"."""
        name = re.sub(r"^metrorail\s+", "", nice_name(self.long_name), flags=re.I)
        number = self.short_name.lstrip("0") or self.short_name
        if (self.mode == "rail" and name) or not number:
            return name or self.short_name
        return name if number.lower() in name.lower() else f"{number} {name}".strip()


@dataclass(frozen=True)
class TripInfo:
    route: int
    service: int
    headsign: str
    shape: int | None
    last_seq: int


# Words that stay in capitals when ALL-CAPS feed text is title-cased (transit centers, park & rides, ...).
_ACRONYMS = {"TC", "TMC", "MLK", "P&R", "IAH", "HCC", "UH", "TSU", "NRG", "FM", "JFK", "NE", "NW", "SE", "SW", "US"}


def nice_name(text: str) -> str:
    """ALL-CAPS feed text in title case, keeping acronyms: "DOWNTOWN TC" -> "Downtown TC"."""
    text = text.strip()
    if not text.isupper():
        return text
    keep = lambda w: w in _ACRONYMS or len(w) == 1 or any(c.isdigit() for c in w)  # noqa: E731
    return " ".join(w if keep(w) else w.title() for w in text.split())


def tidy_stop_name(name: str) -> str:
    """Small fixes to feed stop names: "67Th St Wb" -> "67th St WB", "Dryden/Tmc Stn" -> "Dryden/TMC Stn"."""
    name = re.sub(r"(\d)(St|Nd|Rd|Th)\b", lambda m: m[1] + m[2].lower(), name)
    name = re.sub(r"\b(Nb|Sb|Eb|Wb|Mb|Tmc|Hcc|Tc)\b", lambda m: m[1].upper(), name)
    return re.sub(r"\s{2,}", " ", name).strip()


def clean_headsign(h: str) -> str:
    """"METRORail - FANNIN SOUTH" -> "Fannin South"."""
    return nice_name(re.sub(r"^metrorail\s*-\s*", "", h.strip(), flags=re.I))


# A row of a trip's stop times: (seq, stop, arr, dep, flags)
Row = tuple[int, int, int, int, int]


@dataclass
class _Board:
    seq: int
    stop: int
    dep: int
    walk_m: float


@dataclass
class _Alight:
    seq: int
    stop: int
    arr: int
    walk_m: float

    @property
    def final(self) -> int:
        return self.arr + walk_min(self.walk_m) * 60


@dataclass
class _Ride:
    trip: int
    board: int  # seq
    alight: int  # seq


@dataclass
class _Option:
    rides: list[_Ride]
    access: _Board
    egress: _Alight
    change_m: float  # walk between the rides (0 = same stop or no change)
    leave: int  # seconds: when to set off
    final: int  # seconds: arrival at the destination
    later: list[int]

    @property
    def walk_total_m(self) -> float:
        return self.access.walk_m + self.egress.walk_m + self.change_m

    @property
    def cost(self) -> float:
        # Arriving early counts most, but so do the time on the way (walking twice) and changes: a bus
        # that gets in 2 minutes later after a shorter trip with less walking is the better one.
        on_the_way = self.final - self.leave
        return self.final + 0.5 * on_the_way + 0.5 * walk_s(self.walk_total_m) + CHANGE_PENALTY_S * (len(self.rides) - 1)


class TransitIndex:
    """The transit index file, opened read-only (one SQLite connection per thread)."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._local = threading.local()
        db = self._db()
        self.meta = dict(db.execute("SELECT key, value FROM meta"))
        if self.meta.get("schema") != SCHEMA_VERSION:
            raise ValueError(f"transit index schema {self.meta.get('schema')!r}, expected {SCHEMA_VERSION!r}")
        self.stops = {r[0]: Stop(*r) for r in db.execute("SELECT id, gtfs_id, code, name, lat, lng FROM stops")}
        self.routes = {r[0]: Route(*r) for r in db.execute("SELECT id, gtfs_id, short_name, long_name, type, color, text_color FROM routes")}
        self.trips = {
            r[0]: TripInfo(*r[1:]) for r in db.execute("SELECT id, route, service, headsign, shape, last_seq FROM trips")
        }
        self.services = {r[0]: (r[1], r[2], r[3]) for r in db.execute("SELECT id, days, start_date, end_date FROM services")}
        self.service_dates: dict[str, dict[int, bool]] = defaultdict(dict)
        for sid, day, added in db.execute("SELECT service, date, added FROM service_dates"):
            self.service_dates[day][sid] = bool(added)
        self.max_time = int(self.meta.get("max_time") or 0)
        self.range = service_range(self.meta)
        self._grid: dict[tuple[int, int], list[int]] = defaultdict(list)
        for s in self.stops.values():
            self._grid[self._cell(s.lat, s.lng)].append(s.id)
        self._shapes: dict[int, list[list[float]]] = {}
        self._changes: dict[int, list[tuple[int, float]]] = {}

    # ---- storage ---------------------------------------------------------------------------------

    def _db(self) -> sqlite3.Connection:
        db = getattr(self._local, "db", None)
        if db is None:
            db = sqlite3.connect(f"{self.path.resolve().as_uri()}?mode=ro", uri=True, check_same_thread=False)
            self._local.db = db
        return db

    def _trip_rows(self, trips) -> dict[int, list[Row]]:
        out: dict[int, list[Row]] = defaultdict(list)
        ids = list(trips)
        for i in range(0, len(ids), 500):
            chunk = ids[i : i + 500]
            q = f"SELECT trip, seq, stop, arr, dep, flags FROM stop_times WHERE trip IN ({','.join('?' * len(chunk))}) ORDER BY trip, seq"
            for trip, *row in self._db().execute(q, chunk):
                out[trip].append(tuple(row))
        return out

    def _at_stops(self, stops, column: str, lo: int, hi: int):
        q = (
            f"SELECT trip, seq, stop, arr, dep, flags FROM stop_times "
            f"WHERE stop IN ({','.join('?' * len(stops))}) AND {column} BETWEEN ? AND ?"
        )
        return self._db().execute(q, [*stops, lo, hi]).fetchall()

    def _shape(self, shape_id: int | None) -> list[list[float]] | None:
        if shape_id is None:
            return None
        if shape_id not in self._shapes:
            row = self._db().execute("SELECT points FROM shapes WHERE id = ?", (shape_id,)).fetchone()
            self._shapes[shape_id] = json.loads(row[0]) if row else []
        return self._shapes[shape_id] or None

    # ---- stops and service days -------------------------------------------------------------------

    @staticmethod
    def _cell(lat: float, lng: float) -> tuple[int, int]:
        return int(math.floor(lat * 400)), int(math.floor(lng * 400))  # ~280 x 240 m

    def nearby(self, lat: float, lng: float, radius_m: float, limit: int) -> list[tuple[Stop, float]]:
        """Stops within `radius_m` (straight line), nearest first."""
        dlat = radius_m / 111_320
        dlng = radius_m / (111_320 * math.cos(math.radians(lat)))
        (i0, j0), (i1, j1) = self._cell(lat - dlat, lng - dlng), self._cell(lat + dlat, lng + dlng)
        found = []
        for i in range(i0, i1 + 1):
            for j in range(j0, j1 + 1):
                for sid in self._grid.get((i, j), ()):
                    s = self.stops[sid]
                    d = haversine_m((lat, lng), (s.lat, s.lng))
                    if d <= radius_m:
                        found.append((s, d))
        found.sort(key=lambda x: x[1])
        return found[:limit]

    def change_stops(self, stop: int) -> list[tuple[int, float]]:
        """Stops you can walk to from `stop` to change (itself included, 0 m). Cached: stops don't move."""
        if stop not in self._changes:
            s = self.stops[stop]
            self._changes[stop] = [(n.id, 0.0 if n.id == stop else m) for n, m in self.nearby(s.lat, s.lng, CHANGE_M, 12)]
        return self._changes[stop]

    def active_services(self, day: date) -> set[int]:
        iso = day.isoformat()
        bit = 1 << day.weekday()
        active = {sid for sid, (days, start, end) in self.services.items() if days & bit and start and start <= iso <= end}
        for sid, added in self.service_dates.get(iso, {}).items():
            (active.add if added else active.discard)(sid)
        return active

    def covers(self, day: date) -> bool:
        return self.range is not None and self.range[0] <= day <= self.range[1]

    def feed_json(self) -> dict:
        return {
            "agency": self.meta.get("agency") or None,
            "version": self.meta.get("version") or None,
            "start_date": self.meta.get("service_start") or None,
            "end_date": self.meta.get("service_end") or None,
            "stops": len(self.stops),
            "routes": len(self.routes),
            "trips": len(self.trips),
            "built_at": self.meta.get("built_at"),
        }

    def _contexts(self, when: datetime) -> list[tuple[date, int, set[int]]]:
        """(service day, seconds after its midnight, services running): today's timetable, and
        yesterday's when its trips run past midnight."""
        t = when.hour * 3600 + when.minute * 60 + when.second
        out = []
        for back in (0, 1):
            day = when.date() - timedelta(days=back)
            base = t + back * 86400
            if back and base > self.max_time:
                continue
            services = self.active_services(day)
            if services:
                out.append((day, base, services))
        return out

    # ---- JSON pieces --------------------------------------------------------------------------------

    def _stop_json(self, s: Stop) -> dict:
        return {"id": s.gtfs_id, "code": s.code or None, "name": tidy_stop_name(s.name), "lat": s.lat, "lng": s.lng}

    def _route_json(self, r: Route) -> dict:
        return {
            "id": r.gtfs_id,
            "name": r.label,
            "short_name": r.short_name.lstrip("0") or r.short_name,
            "long_name": r.long_name,
            "mode": r.mode,
            "color": f"#{r.color}" if r.color else None,
            "text_color": f"#{r.text_color}" if r.text_color else None,
        }

    # ---- next departures ----------------------------------------------------------------------------

    def departures(self, stop: Stop, contexts, walk_time_s: int = 0, limit: int = 4) -> list[dict]:
        """The next departure of each route and direction from a stop in the next hour that you can
        still walk to (`walk_time_s` away)."""
        seen: dict[tuple[int, str], dict] = {}
        for day, base, services in contexts:
            midnight = datetime.combine(day, time())
            for trip, seq, _stop, _arr, dep, flags in self._at_stops([stop.id], "dep", base + walk_time_s, base + NEARBY_WINDOW_S):
                info = self.trips.get(trip)
                if info is None or info.service not in services or flags & NO_PICKUP or seq >= info.last_seq:
                    continue
                key = (info.route, info.headsign)
                at = midnight + timedelta(seconds=dep)
                if key not in seen or at < seen[key]["at"]:
                    seen[key] = {"route": self._route_json(self.routes[info.route]), "headsign": clean_headsign(info.headsign), "at": at}
        return sorted(seen.values(), key=lambda d: d["at"])[:limit]

    # ---- trip search --------------------------------------------------------------------------------

    def plan(self, origin: tuple[float, float], destination: tuple[float, float], when: datetime) -> dict:
        out = {
            "status": "ok",
            "message": None,
            "depart_at": when,
            "options": [],
            "nearby": [],
            "walk_only_min": walk_min(haversine_m(origin, destination)),
            "feed": self.feed_json(),
            "legend": LEGEND,
        }
        day = when.date()
        if not self.covers(day):
            if self.range is None:
                return {**out, "status": "no_service", "message": "The timetable we have has no service dates."}
            a, b = self.range
            return {
                **out,
                "status": "outside_dates",
                "message": f"The bus and rail timetable we have runs {_long_day(a)} to {_long_day(b)}, so it doesn't cover {_day(day)}.",
            }
        contexts = self._contexts(when)
        if not contexts:
            return {**out, "status": "no_service", "message": f"No buses or trains are scheduled on {_day(day)}."}

        near_start = self.nearby(*origin, MAX_ACCESS_M, MAX_STOPS_PER_END) or self.nearby(*origin, FAR_ACCESS_M, 8)
        near_end = self.nearby(*destination, MAX_ACCESS_M, MAX_STOPS_PER_END) or self.nearby(*destination, FAR_ACCESS_M, 8)
        nearby = []
        for s, d in near_start:
            if len(nearby) >= NEARBY_STOPS:
                break
            deps = self.departures(s, contexts, walk_min(d) * 60)
            if deps:
                nearby.append({"stop": self._stop_json(s), "walk_min": walk_min(d), "departures": deps})
        out["nearby"] = nearby
        if not near_start:
            return {**out, "status": "no_stops_start", "message": "There's no bus or rail stop within about a 25-minute walk of the start."}
        if not near_end:
            return {**out, "status": "no_stops_end", "message": "There's no bus or rail stop within about a 25-minute walk of where you're going."}

        access = {s.id: d for s, d in near_start}
        egress = {s.id: d for s, d in near_end}
        options: list[tuple[_Option, date, dict[int, list[Row]]]] = []
        for ctx_day, base, services in contexts:
            found, rows = self._search(base, services, access, egress)
            options += [(o, ctx_day, rows) for o in found]
        options.sort(key=lambda x: x[0].cost)
        picked = self._pick([o for o, _, _ in options])
        if not picked:
            return {
                **out,
                "status": "no_trips",
                "message": "No bus or train gets you there in the next 90 minutes, even with one change.",
            }
        by_id = {id(o): (d, rows) for o, d, rows in options}
        out["options"] = [self._option_json(o, *by_id[id(o)], origin, destination) for o in picked]
        return out

    def _search(self, base: int, services: set[int], access: dict[int, float], egress: dict[int, float]):
        """Options leaving at or after `base` (seconds on this service day), direct or with one change."""
        # Boardings near the start that you can walk to in time.
        boards: dict[int, dict[int, _Board]] = defaultdict(dict)
        lo = base + min(walk_min(m) for m in access.values()) * 60
        for trip, seq, stop, _arr, dep, flags in self._at_stops(list(access), "dep", lo, base + BOARD_WINDOW_S):
            info = self.trips.get(trip)
            if info is None or info.service not in services or flags & NO_PICKUP or seq >= info.last_seq:
                continue
            if dep >= base + walk_min(access[stop]) * 60:
                boards[trip][seq] = _Board(seq, stop, dep, access[stop])
        # Alightings near the destination.
        alights: dict[int, dict[int, _Alight]] = defaultdict(dict)
        for trip, seq, stop, arr, _dep, flags in self._at_stops(list(egress), "arr", lo, base + HORIZON_S):
            info = self.trips.get(trip)
            if info is None or info.service not in services or flags & NO_DROP_OFF:
                continue
            alights[trip][seq] = _Alight(seq, stop, arr, egress[stop])
        rows = self._trip_rows(set(boards) | set(alights))

        # First rides: where each can take you (every arrival, by stop and route), and direct trips.
        direct: list[_Option] = []
        reach: dict[tuple[int, int], list[tuple[int, int, _Board, int]]] = defaultdict(list)  # (stop, route) -> [(arr, trip, board, seq)]
        for trip, bs in boards.items():
            route = self.trips[trip].route
            best: _Board | None = None  # the boarding so far with the least walk
            best_direct: _Option | None = None
            for seq, stop, arr, dep, flags in rows[trip]:
                if best is not None and not flags & NO_DROP_OFF:
                    a = alights.get(trip, {}).get(seq)
                    if a is not None:
                        o = _Option([_Ride(trip, best.seq, seq)], best, a, 0.0, best.dep - walk_min(best.walk_m) * 60, a.final, [])
                        if best_direct is None or o.cost < best_direct.cost:
                            best_direct = o
                    reach[(stop, route)].append((arr, trip, best, seq))
                b = bs.get(seq)
                if b is not None and (best is None or b.walk_m < best.walk_m):
                    best = b
            if best_direct is not None:
                direct.append(best_direct)

        # Second rides: from each stop, what gets you to the destination (by departure time).
        back: dict[int, list[tuple[int, int, int, _Alight]]] = defaultdict(list)  # stop -> (dep, trip, seq, alight)
        for trip, al in alights.items():
            best_a: _Alight | None = None
            for seq, stop, _arr, dep, flags in reversed(rows[trip]):
                if best_a is not None and not flags & NO_PICKUP:
                    back[stop].append((dep, trip, seq, best_a))
                a = al.get(seq)
                if a is not None and (best_a is None or a.final < best_a.final):
                    best_a = a
        for lst in back.values():
            lst.sort(key=lambda x: x[0])

        # Join them: ride A to s1, walk to s2 (or stay), ride B.
        best_direct_final = min((o.final for o in direct), default=None)
        changes: dict[tuple[int, int], _Option] = {}
        for (s1, route_a), firsts in reach.items():
            earliest = min(x[0] for x in firsts)
            for s2, m in self.change_stops(s1):
                lst = back.get(s2)
                if not lst:
                    continue
                change_s = math.ceil(walk_s(m) / 60) * 60 + MIN_CHANGE_S
                i = bisect.bisect_left(lst, earliest + change_s, key=lambda x: x[0])
                pick = None
                for dep2, trip_b, seq2, al in lst[i:]:
                    if self.trips[trip_b].route != route_a and (pick is None or al.final < pick[3].final):
                        pick = (dep2, trip_b, seq2, al)
                if pick is None:
                    continue
                dep2, trip_b, seq2, al = pick
                if best_direct_final is not None and al.final >= best_direct_final:
                    continue  # no quicker than riding direct
                # The latest first ride that still makes this connection (less waiting at the change).
                _arr1, trip_a, board, seq1 = max(
                    (x for x in firsts if x[0] + change_s <= dep2), key=lambda x: x[2].dep - walk_min(x[2].walk_m) * 60
                )
                o = _Option(
                    [_Ride(trip_a, board.seq, seq1), _Ride(trip_b, seq2, al.seq)],
                    board, al, m, board.dep - walk_min(board.walk_m) * 60, al.final, [],
                )
                key = (route_a, self.trips[trip_b].route)
                if key not in changes or o.cost < changes[key].cost:
                    changes[key] = o

        # One direct option per route and direction, with its later departures from the same stop.
        by_line: dict[tuple[int, str], list[_Option]] = defaultdict(list)
        for o in direct:
            info = self.trips[o.rides[0].trip]
            by_line[(info.route, info.headsign)].append(o)
        per_line = []
        for opts in by_line.values():
            opts.sort(key=lambda o: o.cost)
            first = opts[0]
            first.later = sorted(
                o.access.dep for o in opts[1:] if o.access.stop == first.access.stop and o.access.dep > first.access.dep
            )[:MAX_LATER]
            per_line.append(first)
        return per_line + list(changes.values()), rows

    def _pick(self, options: list[_Option]) -> list[_Option]:
        """The best few: sorted by cost, without ones that arrive much later than the best."""
        if not options:
            return []
        best_final = min(o.final for o in options)
        return [o for o in options if o.final <= best_final + 30 * 60][:MAX_OPTIONS]

    def _ride_line(self, trip: int, stops: list[Stop]) -> list[list[float]]:
        """The ride along the route's shape between the two stops, or stop to stop when that fails."""
        pts = [[s.lat, s.lng] for s in stops]
        shape = self._shape(self.trips[trip].shape)
        if shape and len(pts) >= 2:
            cut = slice_line(shape, pts[0], pts[-1])
            if cut and _plausible(cut, pts):
                return cut
        return pts

    def _option_json(self, o: _Option, day: date, rows: dict[int, list[Row]], origin, destination) -> dict:
        midnight = datetime.combine(day, time())
        at = lambda s: midnight + timedelta(seconds=s)  # noqa: E731
        legs: list[dict] = []
        start = self.stops[o.access.stop]
        legs.append(_walk_leg(None, origin, self._stop_json(start), o.access.walk_m))
        prev_stop: Stop | None = None
        for ride in o.rides:
            trip_rows = rows[ride.trip]
            between = [r for r in trip_rows if ride.board <= r[0] <= ride.alight]
            s_from, s_to = self.stops[between[0][1]], self.stops[between[-1][1]]
            if prev_stop is not None and prev_stop.id != s_from.id:
                legs.append(_walk_leg(self._stop_json(prev_stop), None, self._stop_json(s_from), o.change_m))
            info = self.trips[ride.trip]
            legs.append(
                {
                    "kind": "ride",
                    "route": self._route_json(self.routes[info.route]),
                    "headsign": clean_headsign(info.headsign),
                    "from": self._stop_json(s_from),
                    "to": self._stop_json(s_to),
                    "depart_at": at(between[0][3]),
                    "arrive_at": at(between[-1][2]),
                    "minutes": round((between[-1][2] - between[0][3]) / 60),
                    "stops": len(between) - 1,
                    "geometry": self._ride_line(ride.trip, [self.stops[r[1]] for r in between]),
                }
            )
            prev_stop = s_to
        end = self.stops[o.egress.stop]
        legs.append(_walk_leg(self._stop_json(end), destination, None, o.egress.walk_m))
        return {
            "leave_at": at(o.leave),
            "arrive_at": at(o.final),
            "minutes": round((o.final - o.leave) / 60),
            "walk_min": sum(leg["minutes"] for leg in legs if leg["kind"] == "walk"),
            "changes": len(o.rides) - 1,
            "legs": legs,
            "later": [at(s) for s in o.later],
        }


def _walk_leg(from_stop: dict | None, point: tuple[float, float] | None, to_stop: dict | None, meters: float) -> dict:
    """A walk: start -> stop, stop -> stop (a change) or stop -> destination."""
    a = [from_stop["lat"], from_stop["lng"]] if from_stop else list(point)  # type: ignore[arg-type]
    b = [to_stop["lat"], to_stop["lng"]] if to_stop else list(point)  # type: ignore[arg-type]
    return {
        "kind": "walk",
        "from": from_stop,
        "to": to_stop,
        "minutes": walk_min(meters),
        "meters": round(meters * WALK_DETOUR),
        "geometry": [a, b],
    }


# ---- route shapes ------------------------------------------------------------------------------------


def _xy(p, k: float) -> tuple[float, float]:
    return p[1] * k, p[0] * 111_320


def _project(line: list[list[float]], p: list[float], start: int = 0) -> tuple[int, list[float], float] | None:
    """The point on the line (from segment `start` on) nearest p: (segment index, point, meters away)."""
    k = math.cos(math.radians(p[0])) * 111_320
    px, py = _xy(p, k)
    best = None
    for i in range(start, len(line) - 1):
        (ax, ay), (bx, by) = _xy(line[i], k), _xy(line[i + 1], k)
        dx, dy = bx - ax, by - ay
        t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
        d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
        if best is None or d < best[2]:
            q = [line[i][0] + (line[i + 1][0] - line[i][0]) * t, line[i][1] + (line[i + 1][1] - line[i][1]) * t]
            best = (i, [round(q[0], 6), round(q[1], 6)], d)
    return best


def slice_line(line: list[list[float]], a: list[float], b: list[float], max_off_m: float = 120) -> list[list[float]] | None:
    """The part of a route shape between the points nearest a and b (in the shape's direction)."""
    pa = _project(line, a)
    if pa is None or pa[2] > max_off_m:
        return None
    pb = _project(line, b, pa[0])
    if pb is None or pb[2] > max_off_m:
        return None
    if pb[0] == pa[0]:
        return [pa[1], pb[1]]
    return [pa[1], *[list(p) for p in line[pa[0] + 1 : pb[0] + 1]], pb[1]]


def _length(line) -> float:
    return sum(haversine_m(tuple(p), tuple(q)) for p, q in zip(line, line[1:]))


def _plausible(cut: list[list[float]], stops: list[list[float]]) -> bool:
    """A shape cut that is about as long as the stop-to-stop line (not the wrong way round a loop)."""
    direct = _length(stops)
    return direct == 0 or 0.8 * direct <= _length(cut) <= 1.6 * direct + 200


# ---- the index the app uses ------------------------------------------------------------------------

_lock = threading.Lock()
_loaded: tuple[Path, float, TransitIndex | None] | None = None


def default_index(path: Path = DEFAULT_PATH) -> TransitIndex | None:
    """The index at `path`, reopened when `make transit` replaces it. None when there isn't one
    (or it can't be read)."""
    global _loaded
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return None
    with _lock:
        if _loaded is not None and _loaded[0] == path and _loaded[1] == mtime:
            return _loaded[2]
        try:
            index: TransitIndex | None = TransitIndex(path)
        except (sqlite3.Error, ValueError, KeyError, TypeError) as e:
            log.warning("Can't read the transit index at %s: %s", path, e)
            index = None
        _loaded = (path, mtime, index)
        return index


NOT_LOADED = "Bus and rail times aren't loaded yet."


def status_json(index: TransitIndex | None, today: date) -> dict:
    if index is None:
        return {"loaded": False, "covers_today": False, "message": NOT_LOADED, "feed": None, "legend": LEGEND}
    return {
        "loaded": True,
        "covers_today": index.covers(today),
        "message": None,
        "feed": index.feed_json(),
        "legend": LEGEND,
    }


def not_loaded_plan(when: datetime) -> dict:
    return {
        "status": "not_loaded",
        "message": NOT_LOADED,
        "depart_at": when,
        "options": [],
        "nearby": [],
        "walk_only_min": None,
        "feed": None,
        "legend": LEGEND,
    }
