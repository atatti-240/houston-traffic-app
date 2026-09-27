"""Avoid tolls / avoid highways: roads a route stays off when it can.

`avoiding(router, Avoid(tolls=True))` is the same router (network, models, live data) with those
segments left out of every search it runs: best route, alternative, the traffic-only route it's
compared with. When there's no way around them (with few surface streets on our map, "no
highways" often has none), the search runs again with them AVOID_PENALTY times as costly, so the
route uses as little of them as it can, and the route says so plainly (avoid_notes).
"""

import copy
from collections.abc import Iterable
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.graph import SegmentInfo
    from app.routing.router import Route, Router, SegmentOnRoute

AVOID_PENALTY = 10.0  # when there's no way around: a minute on an avoided road costs ten elsewhere


@dataclass(frozen=True)
class Avoid:
    tolls: bool = False
    highways: bool = False  # freeways (road_class "freeway"), toll roads included

    def __bool__(self) -> bool:
        return self.tolls or self.highways

    def avoids(self, seg: "SegmentInfo") -> bool:
        return (self.tolls and seg.toll) or (self.highways and seg.road_class == "freeway")

    def to_json(self) -> dict:
        return {"avoid_tolls": self.tolls, "avoid_highways": self.highways}

    @classmethod
    def from_json(cls, d: dict | None) -> "Avoid":
        """From a request / saved plan / saved trip (missing = don't avoid anything)."""
        d = d or {}
        return cls(bool(d.get("avoid_tolls")), bool(d.get("avoid_highways")))


def avoiding(router: "Router", avoid: Avoid) -> "Router":
    """The router, staying off the roads `avoid` names. Cheap: shares everything but that."""
    if not avoid:
        return router
    r = copy.copy(router)
    r.avoid = avoid
    r.avoid_ids = frozenset(sid for sid, seg in router.network.segments.items() if avoid.avoids(seg))
    return r


def _names(segs: Iterable["SegmentOnRoute"]) -> str:
    names = list(dict.fromkeys(s.name for s in segs))
    return names[0] if len(names) == 1 else f"{', '.join(names[:-1])} and {names[-1]}"


def avoid_notes(route: "Route", avoid: Avoid) -> list[str]:
    """What an avoid-route still uses because there was no way around it (none when it avoids all)."""
    notes = []
    if avoid.tolls and (tolls := [s for s in route.segments if s.toll]):
        notes.append(f"No toll-free route: this one uses {_names(tolls)} ({sum(s.miles for s in tolls):.1f} mi)")
    if avoid.highways and (fwy := [s for s in route.segments if s.road_class == "freeway"]):
        notes.append(f"No highway-free route: this one uses {_names(fwy)} ({sum(s.miles for s in fwy):.1f} mi)")
    return notes
