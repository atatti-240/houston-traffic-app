"""Share ETA: a read-only link to one trip. It shows the route and an ETA that is re-checked
against current conditions every time the link is opened.

A share keeps only what that view needs: the two place names, the route (segment ids, plus
the geometry we build from them; never geometry sent by a client), the leave time, the ETA
when it was shared, the latest ETA we worked out and the main road. Nothing about who made it.

Two clocks, on purpose:
  - Leave time, ETAs and "now" are simulated Houston time, like the rest of the app.
  - Expiry is real time (UTC wall clock). A link goes to a real person and should stop
    working 6 real hours later. With simulated expiry, a demo jump to 5 PM would kill every
    link made that morning, and a demo reset back to Monday 7:15 would revive expired ones.

The ETA assumes the driver left at the planned time and is driving this route; we don't know
where they are. Each check re-scores the stored segments (Router.evaluate) from that leave time
under the conditions known now, so a crash or train on the rest of the route pushes it back.
"""

import re
import secrets
import threading
import time
from collections import deque
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from sqlalchemy import JSON, DateTime, Float, String, delete, func, select
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.conditions.provider import PAST_LIVE_TOLERANCE
from app.db import Base
from app.graph import Network
from app.routing.router import Router

SHARE_TTL = timedelta(hours=6)  # real time
MAX_SHARES = 1000  # when full, the oldest links go first
MAX_SEGMENTS = 300
MAX_NAME = 80
MAX_AHEAD = timedelta(hours=24)  # latest leave time a link can be made for
RATE_LIMIT = 30  # new links per client address...
RATE_WINDOW_S = 3600.0  # ...per hour
# Once the latest ETA is this far behind the simulated now, it stays as it is: live data for
# times further back is ignored (see conditions.provider), so a re-check would quietly swap the
# ETA people were shown for a history-only one.
SETTLE_AFTER = PAST_LIVE_TOLERANCE

ID_RE = re.compile(r"[A-Za-z0-9_-]{20,64}")  # secrets.token_urlsafe(16) is 22 chars


class Share(Base):
    """A shared trip (POST /shares). Times are simulated, except created_wall and expires_at."""

    __tablename__ = "shares"

    id: Mapped[str] = mapped_column(String, primary_key=True)  # unguessable: the link is the key
    origin_name: Mapped[str] = mapped_column(String)
    destination_name: Mapped[str] = mapped_column(String)
    main_road: Mapped[str] = mapped_column(String)
    segment_ids: Mapped[list] = mapped_column(JSON)
    geometry: Mapped[list] = mapped_column(JSON)  # [[lat, lng], ...] built from segment_ids
    end_point: Mapped[list] = mapped_column(JSON)  # destination pin [lat, lng]
    miles: Mapped[float] = mapped_column(Float)
    depart_at: Mapped[datetime] = mapped_column(DateTime)
    shared_eta: Mapped[datetime] = mapped_column(DateTime)  # ETA when the link was made
    eta: Mapped[datetime] = mapped_column(DateTime)  # latest ETA we worked out
    created_at: Mapped[datetime] = mapped_column(DateTime)
    created_wall: Mapped[datetime] = mapped_column(DateTime, index=True)  # UTC: oldest go first when full
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)  # UTC
    # Room for snapshot fields added later (e.g. door-to-door legs) without a new column.
    extra: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class ShareError(ValueError):
    pass


def wall_now() -> datetime:
    """Real time in UTC, without a zone (SQLite stores none). Tests move it."""
    return datetime.now(UTC).replace(tzinfo=None)


def new_id() -> str:
    return secrets.token_urlsafe(16)


def valid_id(share_id: str) -> bool:
    return ID_RE.fullmatch(share_id) is not None


def clean_name(raw: str, fallback: str) -> str:
    """One line of printable text, at most MAX_NAME characters."""
    text = " ".join("".join(ch if ch.isprintable() else " " for ch in raw).split())
    return text[:MAX_NAME].rstrip() or fallback


def check_route(network: Network, segment_ids: list[str]) -> None:
    unknown = [sid for sid in segment_ids if sid not in network.segments]
    if unknown:
        raise ShareError(f"Unknown road segments: {', '.join(unknown[:3])}")
    for a, b in zip(segment_ids, segment_ids[1:]):
        if network.segments[a].to_node != network.segments[b].from_node:
            raise ShareError("These road segments don't join up into one route")


def route_geometry(network: Network, segment_ids: list[str]) -> list[list[float]]:
    pts: list[list[float]] = []
    for sid in segment_ids:
        geom = [list(p) for p in network.segments[sid].geometry]
        pts.extend(geom if not pts else geom[1:])
    return pts


def main_road(network: Network, segment_ids: list[str]) -> str:
    """The road with the most miles on the route: "I-45" for a freeway, "Westheimer Rd" for a street."""
    miles: dict[str, float] = {}
    for sid in segment_ids:
        seg = network.segments[sid]
        road = seg.highway if seg.road_class == "freeway" else seg.name
        miles[road] = miles.get(road, 0.0) + seg.length_miles
    return max(miles, key=lambda r: miles[r])


def route_eta(router: Router, segment_ids: list[str], depart_at: datetime) -> datetime:
    """When you'd arrive leaving at depart_at, under the conditions known now."""
    net = router.network
    origin, destination = net.segments[segment_ids[0]].from_node, net.segments[segment_ids[-1]].to_node
    return router.evaluate(segment_ids, origin, destination, depart_at, 0.0, router.view()).arrive_at


def refresh(router: Router, share: Share, now: datetime) -> bool:
    """Re-check share.eta under current conditions. False when it was left as it was: the trip
    ended a while ago (the last ETA stands), or the road map no longer has these segments."""
    if now >= share.eta + SETTLE_AFTER:
        return False
    if any(sid not in router.network.segments for sid in share.segment_ids):
        return False
    share.eta = route_eta(router, share.segment_ids, share.depart_at)
    return True


def status(share: Share, now: datetime) -> str:
    if now < share.depart_at:
        return "not_left"
    if now < share.eta:
        return "on_the_way"
    return "arrived"


def make_room(s: Session, wall: datetime) -> None:
    """Drop expired links, then the oldest ones if we're still at MAX_SHARES."""
    s.execute(delete(Share).where(Share.expires_at <= wall))
    over = (s.scalar(select(func.count()).select_from(Share)) or 0) - MAX_SHARES + 1
    if over > 0:
        oldest = select(Share.id).order_by(Share.created_wall, Share.id).limit(over)
        s.execute(delete(Share).where(Share.id.in_(oldest)))


class RateLimiter:
    """At most `limit` hits per `window_s` seconds per key (a client address). In memory, so it
    starts over when the API restarts."""

    def __init__(
        self, limit: int, window_s: float, max_keys: int = 10_000, clock: Callable[[], float] = time.monotonic
    ) -> None:
        self.limit, self.window_s, self.max_keys, self.clock = limit, window_s, max_keys, clock
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        with self._lock:
            now = self.clock()
            hits = self._hits.get(key)
            if hits is None:
                if len(self._hits) >= self.max_keys:
                    self._prune(now)
                hits = self._hits[key] = deque()
            while hits and now - hits[0] >= self.window_s:
                hits.popleft()
            if len(hits) >= self.limit:
                return False
            hits.append(now)
            return True

    def _prune(self, now: float) -> None:
        """Forget keys with no hits in the window; if that's not enough, the longest idle ones."""
        for key in [k for k, q in self._hits.items() if not q or now - q[-1] >= self.window_s]:
            del self._hits[key]
        extra = len(self._hits) - self.max_keys + 1
        if extra > 0:
            for key in sorted(self._hits, key=lambda k: self._hits[k][-1])[:extra]:
                del self._hits[key]
