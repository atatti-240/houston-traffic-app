"""Driver reports (Waze style): crash, police, hazard (object on the road), pothole, stalled car,
flooding.

A driver reports what they see where they are, or at a spot they tap on the map. A report near
one of our roads is snapped to the direction it sits on (the map draws each direction 55 m to
the right of travel) and becomes an incident in the road-conditions layer, so routing, Why it's
slow, Causes, Alerts and "notify me when it clears" all see it:

    crash, stalled car, flooding   slow the road down (x1.6, x1.2, x2): routes may go around it
    hazard (object on the road)    small slowdown (x1.2)
    police, pothole                heads-up only: listed and pinned, no effect on routes

Flooding covers both directions where they run together. Far from any road we know, a report
stays a pin (listed, never routed around).

A report lasts 45 min (crash, police, stalled car) or 2 h (hazard, pothole, flooding). Each
"still there" pushes that out to a full life from the vote (never past 4 lives in all); two
more "not there" than "still there" votes take it down early. One vote per client (IP address)
per report, so one client can't vote a report away; the reporter's own "not there" withdraws
it. All times are the simulated clock, so the demo's clock jumps age and expire reports too.
"""

import hashlib
import math
import threading
import time
from collections import OrderedDict, deque
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from functools import lru_cache
from typing import Literal

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, UniqueConstraint, delete, select
from sqlalchemy.orm import Mapped, Session, mapped_column, sessionmaker

from app.conditions.live import Incident, IncidentKind
from app.db import Base
from app.graph import Network, SegmentInfo

ReportKindId = Literal["crash", "police", "hazard", "pothole", "stalled", "flooding"]


@dataclass(frozen=True)
class ReportKind:
    label: str  # "Stalled car"
    title: str  # "Stalled car reported"
    incident: IncidentKind  # what the road-conditions layer makes of it
    life: timedelta


KINDS: dict[str, ReportKind] = {
    "crash": ReportKind("Crash", "Crash reported", "crash", timedelta(minutes=45)),
    "police": ReportKind("Police", "Police reported", "police", timedelta(minutes=45)),
    "hazard": ReportKind("Hazard", "Object on the road", "hazard", timedelta(hours=2)),
    "pothole": ReportKind("Pothole", "Pothole reported", "pothole", timedelta(hours=2)),
    "stalled": ReportKind("Stalled car", "Stalled car reported", "stall", timedelta(minutes=45)),
    "flooding": ReportKind("Flooding", "Flooding reported", "flooding", timedelta(hours=2)),
}
# Kinds that never change a route (their incident kind has no slowdown).
HEADS_UP_ONLY = {"police", "pothole"}

DRIVERS = "drivers"
DEMO_DRIVERS = "demo_drivers"  # the demo's canned reports: labeled as demo data, never as real drivers
REPORT_SOURCES = (DRIVERS, DEMO_DRIVERS)

MAX_LIVES = 4  # "still there" can keep a report up at most this many lives from when it was made
REMOVE_MARGIN = 2  # this many more "not there" than "still there" takes a report down
NOTE_MAX = 140
MERGE_M = 300  # the same kind reported this close (on the same road) is the same thing
# Houston area (same box the app uses for "where am I")
LAT_RANGE = (29.4, 30.2)
LNG_RANGE = (-95.9, -94.9)

# Snapping
OFFSET_M = 55  # the map draws each direction this far to the right of travel
SNAP_M = 150  # farther than this from a road's centerline: a pin only
AMBIGUOUS_M = 20  # both directions' lines about as close as this: we can't really tell which
# Water covers the whole road: flooding also floods the other direction where the two run this
# close (a divided freeway's two sides are 20-60 m apart; one-way pairs a block apart aren't).
BOTH_WAYS_M = 70
M_PER_DEG = 111_320

# Abuse limits per client, in real seconds (the simulated clock can stand still or jump).
RATE_WINDOW_S = 600
REPORTS_PER_WINDOW = 6
VOTES_PER_WINDOW = 30

Mine = Literal["reported", "still_there", "not_there"]


class DriverReport(Base):
    __tablename__ = "driver_reports"
    __table_args__ = {"sqlite_autoincrement": True}  # never reuse ids after a demo reset

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    kind: Mapped[str] = mapped_column(String)  # KINDS key
    lat: Mapped[float] = mapped_column(Float)  # where it was reported
    lng: Mapped[float] = mapped_column(Float)
    pin_lat: Mapped[float] = mapped_column(Float)  # where the map shows it (on its direction's line when snapped)
    pin_lng: Mapped[float] = mapped_column(Float)
    segment_id: Mapped[str | None] = mapped_column(String, nullable=True)  # None: not on a road we know
    note: Mapped[str] = mapped_column(String, default="")
    source: Mapped[str] = mapped_column(String)  # DRIVERS | DEMO_DRIVERS
    reporter: Mapped[str] = mapped_column(String)  # client key (hashed)
    created_at: Mapped[datetime] = mapped_column(DateTime, index=True)  # simulated time
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    still_there: Mapped[int] = mapped_column(Integer, default=0)
    not_there: Mapped[int] = mapped_column(Integer, default=0)
    removed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)  # voted away / withdrawn


class DriverReportVote(Base):
    """One client's vote on one report (changing your mind updates it)."""

    __tablename__ = "driver_report_votes"
    __table_args__ = (UniqueConstraint("report_id", "voter"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    report_id: Mapped[int] = mapped_column(ForeignKey("driver_reports.id"), index=True)
    voter: Mapped[str] = mapped_column(String)
    still_there: Mapped[bool] = mapped_column(Boolean)
    at: Mapped[datetime] = mapped_column(DateTime)


@dataclass(frozen=True)
class ReportIncident(Incident):
    """An incident that came from a driver report, with what alerts need to label it."""

    report_id: int = 0
    report_kind: str = ""
    still_there: int = 0
    not_there: int = 0


# --- labels ---------------------------------------------------------------------------------------


def client_key(host: str | None) -> str:
    """What a client is known by: a hash of its address (the address itself isn't stored)."""
    return hashlib.sha256(f"blindspot-reports:{host or 'unknown'}".encode()).hexdigest()[:16]


def ago(then: datetime, now: datetime) -> str:
    minutes = max(0, round((now - then).total_seconds() / 60))
    if minutes == 0:
        return "just now"
    if minutes < 60:
        return f"{minutes} min ago"
    h, m = divmod(minutes, 60)
    return f"{h} h {m} min ago" if m else f"{h} h ago"


def reported_by(source: str, still_there: int) -> str:
    if source == DEMO_DRIVERS:
        return "Demo report"
    return "Reported by drivers" if still_there else "Reported by a driver"


def provenance(r: DriverReport, now: datetime) -> str:
    """"Reported by drivers, 12 min ago, 3 still there"."""
    parts = [reported_by(r.source, r.still_there), ago(r.created_at, now)]
    if r.still_there:
        parts.append(f"{r.still_there} still there")
    return ", ".join(parts)


def report_impact(inc, delay_min: int | None, masked: bool = False) -> str | None:
    """The impact line of a traffic alert for a driver report ("Reported by drivers, 3 still
    there · +6 min"); None for any other incident."""
    if not isinstance(inc, ReportIncident):
        return None
    who = reported_by(inc.source, inc.still_there)
    if inc.still_there:
        who += f", {inc.still_there} still there"
    if delay_min:
        return f"{who} · +{delay_min} min"
    if masked or inc.report_kind in HEADS_UP_ONLY or inc.segment_id is None:
        return who
    return f"{who} · no delay yet"


def clean_note(note: str) -> str:
    """One line of plain text, at most NOTE_MAX characters."""
    text = "".join(ch if ch.isprintable() else " " for ch in note)
    return " ".join(text.split())[:NOTE_MAX]


def in_houston(lat: float, lng: float) -> bool:
    return LAT_RANGE[0] <= lat <= LAT_RANGE[1] and LNG_RANGE[0] <= lng <= LNG_RANGE[1]


# --- snapping -------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Snap:
    segment_id: str | None  # None: not near a road we know
    lat: float  # where the pin goes: on that direction's line, or where it was reported
    lng: float
    distance_m: float  # from the road's centerline (inf when there's no road)
    reverse_id: str | None = None  # the other direction, to switch to
    ambiguous: bool = False  # about as close to both directions


def offset_line(geom, meters: float = OFFSET_M) -> list[tuple[float, float]]:
    """The line the map draws for a direction: shifted `meters` to the right of travel (the
    frontend's offsetLine in TrafficMap.tsx, point for point)."""
    if len(geom) < 2:
        return [tuple(p) for p in geom]
    cos = math.cos(math.radians(geom[0][0]))
    k = meters / M_PER_DEG
    normals = []
    for a, b in zip(geom, geom[1:]):
        dx, dy = (b[1] - a[1]) * cos, b[0] - a[0]
        length = math.hypot(dx, dy) or 1.0
        normals.append((-dx / length, dy / length))  # right of travel: (dLat, dLng scaled)
    out = []
    for i, (lat, lng) in enumerate(geom):
        prev, nxt = normals[max(0, i - 1)], normals[min(len(normals) - 1, i)]
        n_lat, n_lng = prev[0] + nxt[0], prev[1] + nxt[1]
        length = math.hypot(n_lat, n_lng) or 1.0
        out.append((lat + n_lat / length * k, lng + n_lng / length * k / cos))
    return out


def _nearest_on(line, lat: float, lng: float) -> tuple[float, float, float]:
    """(meters, lat, lng) of the closest point on a polyline, in a flat projection around the point."""
    cos = math.cos(math.radians(lat))
    pts = [((p[1] - lng) * cos * M_PER_DEG, (p[0] - lat) * M_PER_DEG) for p in line]
    pairs = list(zip(pts, pts[1:])) or [(pts[0], pts[0])]
    best = (math.inf, lat, lng)
    for (ax, ay), (bx, by) in pairs:
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        t = 0.0 if seg2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / seg2))
        x, y = ax + t * dx, ay + t * dy
        d = math.hypot(x, y)
        if d < best[0]:
            best = (d, lat + y / M_PER_DEG, lng + x / (cos * M_PER_DEG))
    return best


def _reverse(network: Network, seg: SegmentInfo) -> str | None:
    rid = seg.reverse_id
    return rid if rid in network.segments and rid != seg.id else None


@lru_cache(maxsize=2048)
def _drawn(geometry: tuple[tuple[float, float], ...]) -> tuple[tuple[float, float], ...]:
    return tuple(offset_line(geometry))


def snap_point(network: Network, lat: float, lng: float, segment_id: str | None = None) -> Snap:
    """The road direction a report at (lat, lng) is on. `segment_id` picks it (it has to be
    within SNAP_M of the point, else ValueError); otherwise the direction whose drawn line is
    closest (what you tap is the line you see), if its road is within SNAP_M."""
    if segment_id is not None:
        seg = network.segments.get(segment_id)
        if seg is None:
            raise ValueError(f"unknown road segment {segment_id!r}")
        center = _nearest_on(seg.geometry, lat, lng)[0]
        if center > SNAP_M:
            raise ValueError("That road isn't where the report is")
        _, plat, plng = _nearest_on(_drawn(seg.geometry), lat, lng)
        return Snap(seg.id, plat, plng, center, _reverse(network, seg))

    placed = {seg.id: _nearest_on(_drawn(seg.geometry), lat, lng) for seg in network.segments.values()}
    best_id = min(placed, key=lambda sid: placed[sid][0], default=None)
    if best_id is None:
        return Snap(None, lat, lng, math.inf)
    seg = network.segments[best_id]
    center = _nearest_on(seg.geometry, lat, lng)[0]
    if center > SNAP_M:
        return Snap(None, lat, lng, math.inf)
    d, plat, plng = placed[best_id]
    rev = _reverse(network, seg)
    ambiguous = rev is not None and placed[rev][0] - d < AMBIGUOUS_M
    return Snap(seg.id, plat, plng, center, rev, ambiguous)


def flooded_other_way(network: Network, r: "DriverReport") -> str | None:
    """The other direction of a flooding report's road, when it runs right where the water is
    (one-way pairs a block apart don't count)."""
    seg = network.segments.get(r.segment_id) if r.kind == "flooding" and r.segment_id else None
    rev = _reverse(network, seg) if seg else None
    if rev is None:
        return None
    _, lat, lng = _nearest_on(seg.geometry, r.lat, r.lng)  # where on the road it is
    return rev if _nearest_on(network.segments[rev].geometry, lat, lng)[0] <= BOTH_WAYS_M else None


def nearest_place(network: Network, lat: float, lng: float) -> str:
    cos = math.cos(math.radians(lat))
    places = network.places() or list(network.nodes.values())
    return min(places, key=lambda n: (n.lat - lat) ** 2 + ((n.lng - lng) * cos) ** 2).name


def point_along(seg: SegmentInfo, fraction: float) -> tuple[float, float]:
    """A point `fraction` of the way along a direction's drawn line."""
    line = offset_line(seg.geometry)
    cos = math.cos(math.radians(line[0][0]))
    steps = [math.hypot(q[0] - p[0], (q[1] - p[1]) * cos) for p, q in zip(line, line[1:])]
    target, run = sum(steps) * fraction, 0.0
    for (p, q), d in zip(zip(line, line[1:]), steps):
        if d > 0 and run + d >= target:
            t = (target - run) / d
            return p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t
        run += d
    return line[-1]


def _meters(a: tuple[float, float], b: tuple[float, float]) -> float:
    cos = math.cos(math.radians(a[0]))
    return math.hypot(b[0] - a[0], (b[1] - a[1]) * cos) * M_PER_DEG


# --- abuse limits ---------------------------------------------------------------------------------


class RateLimiter:
    """At most `limit` hits per `window_s` real seconds per key. Remembers at most `max_keys`
    keys (the least recently seen are forgotten), so memory stays bounded."""

    def __init__(self, limit: int, window_s: float, max_keys: int = 10_000) -> None:
        self.limit = limit
        self.window = window_s
        self.max_keys = max_keys
        self._hits: OrderedDict[str, deque[float]] = OrderedDict()
        self._lock = threading.Lock()

    def hit(self, key: str, now: float | None = None) -> float | None:
        """Count one hit. Over the limit: not counted, returns the seconds until one is allowed."""
        now = time.monotonic() if now is None else now
        with self._lock:
            q = self._hits.pop(key, None) or deque()
            while q and now - q[0] >= self.window:
                q.popleft()
            self._hits[key] = q
            if len(q) >= self.limit:
                return max(1.0, self.window - (now - q[0]))
            q.append(now)
            while len(self._hits) > self.max_keys:
                self._hits.popitem(last=False)
            return None

    def clear(self) -> None:
        with self._lock:
            self._hits.clear()


# --- store ----------------------------------------------------------------------------------------


def _active(r: DriverReport, now: datetime) -> bool:
    return r.removed_at is None and r.created_at <= now < r.expires_at


class ReportStore:
    """Reports in SQLite, plus the per-client limits. `network` returns the current road network."""

    def __init__(self, session_factory: sessionmaker[Session], network: Callable[[], Network]) -> None:
        self.session_factory = session_factory
        self._network = network
        bind = session_factory.kw.get("bind")
        if bind is not None:
            # A database from before reports existed gets its tables here, whatever was imported first.
            Base.metadata.create_all(bind, tables=[DriverReport.__table__, DriverReportVote.__table__])
        self.report_limit = RateLimiter(REPORTS_PER_WINDOW, RATE_WINDOW_S)
        self.vote_limit = RateLimiter(VOTES_PER_WINDOW, RATE_WINDOW_S)
        self._lock = threading.Lock()  # one write at a time: votes read-modify-write the counts

    @property
    def network(self) -> Network:
        return self._network()

    def snap(self, lat: float, lng: float, segment_id: str | None = None) -> Snap:
        return snap_point(self.network, lat, lng, segment_id)

    # --- reading ----------------------------------------------------------------------------

    def active(self, now: datetime) -> list[DriverReport]:
        """Reports up right now, newest first (made by `now`: the demo clock can go back)."""
        with self.session_factory() as s:
            return list(
                s.scalars(
                    select(DriverReport)
                    .where(
                        DriverReport.removed_at.is_(None),
                        DriverReport.created_at <= now,
                        DriverReport.expires_at > now,
                    )
                    .order_by(DriverReport.created_at.desc(), DriverReport.id.desc())
                )
            )

    def get(self, report_id: int) -> DriverReport | None:
        with self.session_factory() as s:
            return s.get(DriverReport, report_id)

    def mine(self, report_ids: list[int], client: str) -> dict[int, Mine]:
        """How this client stands on each report: reported it, or voted."""
        if not report_ids:
            return {}
        with self.session_factory() as s:
            out: dict[int, Mine] = {
                r.id: "reported"
                for r in s.scalars(select(DriverReport).where(DriverReport.id.in_(report_ids), DriverReport.reporter == client))
            }
            for v in s.scalars(
                select(DriverReportVote).where(DriverReportVote.report_id.in_(report_ids), DriverReportVote.voter == client)
            ):
                out.setdefault(v.report_id, "still_there" if v.still_there else "not_there")
            return out

    def incidents(self, now: datetime) -> list[Incident]:
        """Active reports as incidents for the road-conditions layer. Flooding counts for both
        directions where they run together, unless the other one has a flooding report of its own."""
        network = self.network
        rows = self.active(now)
        out = [self.incident(r, now, network) for r in rows]
        floods = [r for r in rows if r.kind == "flooding"]
        for r, inc in zip(rows, out[:]):
            other = flooded_other_way(network, r)
            if other and not any(f.segment_id == other and _meters((f.lat, f.lng), (r.lat, r.lng)) <= MERGE_M for f in floods):
                out.append(replace(inc, id=f"{inc.id}-other", segment_id=other))
        return out

    def incident(self, r: DriverReport, now: datetime, network: Network) -> ReportIncident:
        kind = KINDS[r.kind]
        on_road = r.segment_id if r.segment_id in network.segments else None
        if on_road:
            detail = provenance(r, now) + (f". “{r.note}”" if r.note else "")
        else:
            detail = f"Near {nearest_place(network, r.lat, r.lng)}"
        return ReportIncident(
            id=f"report-{r.id}",
            title=kind.title,
            kind=kind.incident,
            segment_id=on_road,
            started_at=r.created_at,
            source=r.source,
            updated_at=r.created_at,  # "12 min ago" is when it was reported
            clears_at=r.expires_at,
            lanes_blocked=1,
            detail=detail,
            report_id=r.id,
            report_kind=r.kind,
            still_there=r.still_there,
            not_there=r.not_there,
        )

    # --- writing ----------------------------------------------------------------------------

    def create(
        self,
        kind: str,
        lat: float,
        lng: float,
        note: str,
        client: str,
        now: datetime,
        snap: Snap | None = None,
        source: str = DRIVERS,
    ) -> tuple[DriverReport, bool]:
        """A new report, or (merged=True) a "still there" on the same thing already reported
        right there by someone else."""
        snap = snap or self.snap(lat, lng)
        with self._lock, self.session_factory() as s:
            same = s.scalars(
                select(DriverReport).where(
                    DriverReport.kind == kind,
                    DriverReport.removed_at.is_(None),
                    DriverReport.created_at <= now,
                    DriverReport.expires_at > now,
                    DriverReport.segment_id.is_(None) if snap.segment_id is None else DriverReport.segment_id == snap.segment_id,
                )
            )
            dup = next((r for r in same if _meters((r.lat, r.lng), (lat, lng)) <= MERGE_M), None)
            if dup is not None:
                self._vote(s, dup, client, True, now)
                s.commit()
                return dup, True
            r = DriverReport(
                kind=kind,
                lat=lat,
                lng=lng,
                pin_lat=snap.lat,
                pin_lng=snap.lng,
                segment_id=snap.segment_id,
                note=clean_note(note),
                source=source,
                reporter=client,
                created_at=now,
                expires_at=now + KINDS[kind].life,
                still_there=0,
                not_there=0,
            )
            s.add(r)
            s.commit()
            return r, False

    def vote(self, report_id: int, client: str, still_there: bool, now: datetime) -> DriverReport | None:
        """The report after this client's vote (removed_at set when that took it down), or None
        when there's no such report up right now."""
        with self._lock, self.session_factory() as s:
            r = s.get(DriverReport, report_id)
            if r is None or not _active(r, now):
                return None
            self._vote(s, r, client, still_there, now)
            s.commit()
            return r

    def _vote(self, s: Session, r: DriverReport, voter: str, still: bool, now: datetime) -> None:
        if voter == r.reporter:
            if not still:
                r.removed_at = now  # the reporter takes it back
            return
        prev = s.scalar(select(DriverReportVote).where(DriverReportVote.report_id == r.id, DriverReportVote.voter == voter))
        if prev is not None and prev.still_there == still:
            return  # one vote per client
        if prev is None:
            s.add(DriverReportVote(report_id=r.id, voter=voter, still_there=still, at=now))
        else:  # changed their mind
            if prev.still_there:
                r.still_there = max(0, r.still_there - 1)
            else:
                r.not_there = max(0, r.not_there - 1)
            prev.still_there, prev.at = still, now
        if still:
            r.still_there += 1
            life = KINDS[r.kind].life
            r.expires_at = min(r.created_at + MAX_LIVES * life, max(r.expires_at, now + life))
        else:
            r.not_there += 1
            if r.not_there - r.still_there >= REMOVE_MARGIN:
                r.removed_at = now

    def add_demo(
        self,
        kind: str,
        segment_id: str,
        created_at: datetime,
        still_there: int = 0,
        not_there: int = 0,
        note: str = "",
        along: float = 0.3,
    ) -> DriverReport:
        """A canned report for a demo scenario (source DEMO_DRIVERS, so it's labeled as demo data).
        It sits `along` the way down the road's drawn line (the cause icon is at the middle)."""
        seg = self.network.segments[segment_id]
        lat, lng = point_along(seg, along)
        with self._lock, self.session_factory() as s:
            r = DriverReport(
                kind=kind,
                lat=lat,
                lng=lng,
                pin_lat=lat,
                pin_lng=lng,
                segment_id=segment_id,
                note=clean_note(note),
                source=DEMO_DRIVERS,
                reporter="demo",
                created_at=created_at,
                expires_at=created_at + KINDS[kind].life,
                still_there=still_there,
                not_there=not_there,
            )
            s.add(r)
            s.commit()
            return r

    def clear(self, demo_only: bool = False) -> None:
        """Drop every report (demo reset), or only the demo's canned ones."""
        with self._lock, self.session_factory() as s:
            if demo_only:
                ids = select(DriverReport.id).where(DriverReport.source == DEMO_DRIVERS)
                s.execute(delete(DriverReportVote).where(DriverReportVote.report_id.in_(ids)))
                s.execute(delete(DriverReport).where(DriverReport.source == DEMO_DRIVERS))
            else:
                s.execute(delete(DriverReportVote))
                s.execute(delete(DriverReport))
            s.commit()
        if not demo_only:
            # A fresh start: a rehearsal's reports and votes don't count against the live demo.
            self.report_limit.clear()
            self.vote_limit.clear()
