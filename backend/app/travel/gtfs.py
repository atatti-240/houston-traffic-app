"""Build the transit index: a GTFS feed (a zip, or a folder of .txt files) -> one compact SQLite file.

Keeps what trip searches and next departures need: stops, routes, trips, stop times (seconds after
midnight of the service day, so "25:10:00" stays 90600), the service calendar and each route's
shape (simplified). Written to a temp file and then moved into place, so a running app never
reads a half-built index.
"""

import csv
import io
import json
import math
import sqlite3
import zipfile
from collections import defaultdict
from collections.abc import Iterator
from datetime import date, datetime, timezone
from pathlib import Path

SCHEMA_VERSION = "1"

SCHEMA = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE stops (id INTEGER PRIMARY KEY, gtfs_id TEXT, code TEXT, name TEXT, lat REAL, lng REAL);
CREATE TABLE routes (id INTEGER PRIMARY KEY, gtfs_id TEXT, short_name TEXT, long_name TEXT, type INTEGER,
                     color TEXT, text_color TEXT);
CREATE TABLE services (id INTEGER PRIMARY KEY, gtfs_id TEXT, days INTEGER, start_date TEXT, end_date TEXT);
CREATE TABLE service_dates (service INTEGER, date TEXT, added INTEGER);
CREATE TABLE shapes (id INTEGER PRIMARY KEY, gtfs_id TEXT, points TEXT);
CREATE TABLE trips (id INTEGER PRIMARY KEY, gtfs_id TEXT, route INTEGER, service INTEGER, headsign TEXT,
                    shape INTEGER, last_seq INTEGER);
CREATE TABLE stop_times (trip INTEGER, seq INTEGER, stop INTEGER, arr INTEGER, dep INTEGER, flags INTEGER,
                         PRIMARY KEY (trip, seq)) WITHOUT ROWID;
"""

# stop_times.flags
NO_PICKUP = 1
NO_DROP_OFF = 2

WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
SHAPE_TOLERANCE_M = 4  # drop shape points closer than this to the line


class FeedError(ValueError):
    """The feed is missing something the index needs."""


class _Feed:
    """Reads the .txt tables of a GTFS zip or folder."""

    def __init__(self, source: Path) -> None:
        self.source = source
        self._zip = zipfile.ZipFile(source) if source.is_file() else None
        if self._zip is not None:
            # Some feeds nest the files in a folder inside the zip.
            self._names = {Path(n).name: n for n in self._zip.namelist() if n.endswith(".txt")}
        elif source.is_dir():
            self._names = {p.name: str(p) for p in source.glob("*.txt")}
        else:
            raise FeedError(f"No GTFS feed at {source}")

    def has(self, name: str) -> bool:
        return name in self._names

    def rows(self, name: str) -> Iterator[dict[str, str]]:
        if name not in self._names:
            raise FeedError(f"The feed has no {name}")
        raw = self._zip.open(self._names[name]) if self._zip else open(self._names[name], "rb")
        with io.TextIOWrapper(raw, encoding="utf-8-sig", newline="") as f:
            for row in csv.DictReader(f):
                yield {k.strip(): (v or "").strip() for k, v in row.items() if k is not None}

    def close(self) -> None:
        if self._zip is not None:
            self._zip.close()


def parse_time(value: str) -> int | None:
    """GTFS "H:MM:SS" (hours can pass 24) -> seconds after the service day's midnight."""
    if not value:
        return None
    h, m, s = value.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def _iso(gtfs_date: str) -> str:
    return datetime.strptime(gtfs_date, "%Y%m%d").date().isoformat()


def _meters(a: tuple[float, float], b: tuple[float, float]) -> float:
    k = math.cos(math.radians((a[0] + b[0]) / 2))
    return math.hypot((a[0] - b[0]) * 111_320, (a[1] - b[1]) * 111_320 * k)


def simplify(points: list[tuple[float, float]], tol_m: float) -> list[tuple[float, float]]:
    """Douglas-Peucker in meters."""
    if len(points) < 3:
        return points
    k = math.cos(math.radians(points[0][0])) * 111_320
    xy = [(p[1] * k, p[0] * 111_320) for p in points]

    def off(i: int, a: int, b: int) -> float:
        (ax, ay), (bx, by), (px, py) = xy[a], xy[b], xy[i]
        dx, dy = bx - ax, by - ay
        if dx == dy == 0:
            return math.hypot(px - ax, py - ay)
        t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
        return math.hypot(px - (ax + t * dx), py - (ay + t * dy))

    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        best, idx = 0.0, None
        for i in range(a + 1, b):
            d = off(i, a, b)
            if d > best:
                best, idx = d, i
        if idx is not None and best > tol_m:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, kept in zip(points, keep) if kept]


def _interpolate_missing_times(db: sqlite3.Connection) -> None:
    """Stops between timepoints may have no times: spread them evenly between the timed ones.
    Rows that can't be placed (no timed stop before or after) are dropped."""
    trips = [t for (t,) in db.execute("SELECT DISTINCT trip FROM stop_times WHERE arr IS NULL OR dep IS NULL")]
    for trip in trips:
        rows = db.execute("SELECT seq, arr, dep FROM stop_times WHERE trip = ? ORDER BY seq", (trip,)).fetchall()
        times = [(a if a is not None else d, d if d is not None else a) for _, a, d in rows]
        timed = [i for i, (a, _) in enumerate(times) if a is not None]
        for i, (a, _) in enumerate(times):
            if a is not None:
                continue
            before = max((j for j in timed if j < i), default=None)
            after = min((j for j in timed if j > i), default=None)
            if before is None or after is None:
                db.execute("DELETE FROM stop_times WHERE trip = ? AND seq = ?", (trip, rows[i][0]))
                continue
            t0, t1 = times[before][1], times[after][0]
            t = round(t0 + (t1 - t0) * (i - before) / (after - before))
            times[i] = (t, t)
        for (seq, a, d), (na, nd) in zip(rows, times):
            if (a is None or d is None) and na is not None:
                db.execute("UPDATE stop_times SET arr = ?, dep = ? WHERE trip = ? AND seq = ?", (na, nd, trip, seq))


def build_index(source: Path, out: Path, source_label: str | None = None) -> dict[str, str]:
    """Build the index at `out` from the feed at `source`. Returns the index's meta table."""
    feed = _Feed(source)
    tmp = out.with_name(f"{out.stem}.tmp{out.suffix}")  # transit.tmp.db: ignored like the index
    tmp.unlink(missing_ok=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(tmp)
    try:
        meta = _fill(db, feed, source_label or source.name)
        db.commit()
        db.execute("VACUUM")
        db.close()
        tmp.replace(out)
        return meta
    except BaseException:
        db.close()
        tmp.unlink(missing_ok=True)
        raise
    finally:
        feed.close()


def _fill(db: sqlite3.Connection, feed: _Feed, source_label: str) -> dict[str, str]:
    db.executescript(SCHEMA)
    for name in ("stops.txt", "routes.txt", "trips.txt", "stop_times.txt"):
        if not feed.has(name):
            raise FeedError(f"The feed has no {name}")
    if not (feed.has("calendar.txt") or feed.has("calendar_dates.txt")):
        raise FeedError("The feed has no calendar.txt or calendar_dates.txt")

    # Stops (stations and entrances are not places a bus stops)
    stop_id: dict[str, int] = {}
    for r in feed.rows("stops.txt"):
        if r.get("location_type", "") not in ("", "0") or not r.get("stop_lat") or not r.get("stop_lon"):
            continue
        stop_id[r["stop_id"]] = len(stop_id) + 1
        db.execute(
            "INSERT INTO stops VALUES (?, ?, ?, ?, ?, ?)",
            (stop_id[r["stop_id"]], r["stop_id"], r.get("stop_code", ""), r.get("stop_name", ""),
             float(r["stop_lat"]), float(r["stop_lon"])),
        )

    route_id: dict[str, int] = {}
    for r in feed.rows("routes.txt"):
        route_id[r["route_id"]] = len(route_id) + 1
        db.execute(
            "INSERT INTO routes VALUES (?, ?, ?, ?, ?, ?, ?)",
            (route_id[r["route_id"]], r["route_id"], r.get("route_short_name", ""), r.get("route_long_name", ""),
             int(r.get("route_type") or 3), r.get("route_color", ""), r.get("route_text_color", "")),
        )

    # Service calendar: weekday pattern + date range, then added / removed dates
    service_id: dict[str, int] = {}

    def service(gid: str) -> int:
        if gid not in service_id:
            service_id[gid] = len(service_id) + 1
            db.execute("INSERT INTO services VALUES (?, ?, 0, NULL, NULL)", (service_id[gid], gid))
        return service_id[gid]

    first, last = [], []
    if feed.has("calendar.txt"):
        for r in feed.rows("calendar.txt"):
            days = sum(1 << i for i, d in enumerate(WEEKDAYS) if r.get(d) == "1")
            sid = service(r["service_id"])
            start, end = _iso(r["start_date"]), _iso(r["end_date"])
            db.execute("UPDATE services SET days = ?, start_date = ?, end_date = ? WHERE id = ?", (days, start, end, sid))
            if days:
                first.append(start)
                last.append(end)
    if feed.has("calendar_dates.txt"):
        for r in feed.rows("calendar_dates.txt"):
            added = r.get("exception_type") == "1"
            day = _iso(r["date"])
            db.execute("INSERT INTO service_dates VALUES (?, ?, ?)", (service(r["service_id"]), day, int(added)))
            if added:
                first.append(day)
                last.append(day)

    shape_id: dict[str, int] = {}
    if feed.has("shapes.txt"):
        pts: dict[str, list[tuple[int, float, float]]] = defaultdict(list)
        for r in feed.rows("shapes.txt"):
            pts[r["shape_id"]].append((int(r["shape_pt_sequence"]), float(r["shape_pt_lat"]), float(r["shape_pt_lon"])))
        for gid, rows in pts.items():
            rows.sort()
            line = simplify([(lat, lng) for _, lat, lng in rows], SHAPE_TOLERANCE_M)
            shape_id[gid] = len(shape_id) + 1
            db.execute(
                "INSERT INTO shapes VALUES (?, ?, ?)",
                (shape_id[gid], gid, json.dumps([[round(a, 5), round(b, 5)] for a, b in line], separators=(",", ":"))),
            )

    trip_id: dict[str, int] = {}
    for r in feed.rows("trips.txt"):
        if r["route_id"] not in route_id:
            continue
        trip_id[r["trip_id"]] = len(trip_id) + 1
        db.execute(
            "INSERT INTO trips VALUES (?, ?, ?, ?, ?, ?, NULL)",
            (trip_id[r["trip_id"]], r["trip_id"], route_id[r["route_id"]], service(r["service_id"]),
             r.get("trip_headsign", ""), shape_id.get(r.get("shape_id", ""))),
        )

    batch: list[tuple] = []
    max_time = 0
    for r in feed.rows("stop_times.txt"):
        trip, stop = trip_id.get(r["trip_id"]), stop_id.get(r["stop_id"])
        if trip is None or stop is None:
            continue
        arr, dep = parse_time(r.get("arrival_time", "")), parse_time(r.get("departure_time", ""))
        flags = (NO_PICKUP if r.get("pickup_type") == "1" else 0) | (NO_DROP_OFF if r.get("drop_off_type") == "1" else 0)
        batch.append((trip, int(r["stop_sequence"]), stop, arr, dep, flags))
        max_time = max(max_time, dep or 0, arr or 0)
        if len(batch) >= 50_000:
            db.executemany("INSERT OR REPLACE INTO stop_times VALUES (?, ?, ?, ?, ?, ?)", batch)
            batch.clear()
    db.executemany("INSERT OR REPLACE INTO stop_times VALUES (?, ?, ?, ?, ?, ?)", batch)
    _interpolate_missing_times(db)
    db.execute("UPDATE trips SET last_seq = (SELECT MAX(seq) FROM stop_times WHERE stop_times.trip = trips.id)")
    db.execute("DELETE FROM trips WHERE last_seq IS NULL")
    db.execute("CREATE INDEX stop_times_by_stop ON stop_times (stop, dep)")

    agencies = list(feed.rows("agency.txt")) if feed.has("agency.txt") else []
    info = next(feed.rows("feed_info.txt"), {}) if feed.has("feed_info.txt") else {}
    count = lambda table: str(db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])  # noqa: E731
    meta = {
        "schema": SCHEMA_VERSION,
        "agency": ", ".join(a.get("agency_name", "") for a in agencies),
        "timezone": agencies[0].get("agency_timezone", "") if agencies else "",
        "publisher": info.get("feed_publisher_name", ""),
        "version": info.get("feed_version", ""),
        "service_start": min(first, default=""),
        "service_end": max(last, default=""),
        "max_time": str(max_time),
        "stops": count("stops"),
        "routes": count("routes"),
        "trips": count("trips"),
        "stop_times": count("stop_times"),
        "source": source_label,
        "built_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
    }
    db.executemany("INSERT INTO meta VALUES (?, ?)", list(meta.items()))
    return meta


def service_range(meta: dict[str, str]) -> tuple[date, date] | None:
    if not meta.get("service_start") or not meta.get("service_end"):
        return None
    return date.fromisoformat(meta["service_start"]), date.fromisoformat(meta["service_end"])
