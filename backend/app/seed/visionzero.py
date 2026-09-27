"""Real street crash data: City of Houston Vision Zero High Injury Network (HIN) 2025.

hin2025.json holds the city's 1,080 HIN segments (~0.5 mi each) with their crash and death
counts, from the public ArcGIS layer (spikes/crash_hotspots.py). City streets only: the HIN
has no freeways, so freeway links keep their hand-set crash_mult.

A street link matches the HIN rows with the same street name whose midpoint lies within
MATCH_RADIUS_M of its road shape (the real street, see network.segment_geometry). The name has
to match too, so a cross street or the same street on the far side of town doesn't count.
"""

import json
import math
from dataclasses import dataclass
from functools import cache
from pathlib import Path

SOURCE = "City of Houston Vision Zero HIN 2025"
MATCH_RADIUS_M = 400.0  # half a HIN segment (0.5 mi): any segment overlapping the street counts
MAX_FACTOR = 4.0  # x ARTERIAL_CRASH_MULT (0.5) = 2.0, below the worst freeway links (2.2-2.6)

_SUFFIXES = {"RD", "ST", "BLVD", "AVE", "AV", "DR", "TRL", "TRAIL", "PKWY", "LN", "WAY", "HWY"}
_DIRECTIONS = {"N", "S", "E", "W", "NORTH", "SOUTH", "EAST", "WEST"}


@dataclass(frozen=True)
class HinSegment:
    name: str  # as the city spells it, e.g. "WESTHEIMER RD"
    crashes: int
    deaths: int
    miles: float
    crash_rate: float  # crashes per mile
    lat: float  # segment midpoint
    lng: float


@cache
def hin_segments() -> tuple[HinSegment, ...]:
    rows = json.loads(Path(__file__).with_name("hin2025.json").read_text())
    return tuple(
        HinSegment(
            r["Full_Name"], r["Total_Crash_Count"], r["Total_Death_Count"], r["Miles"], r["CrashRate"], r["lat"], r["lng"]
        )
        for r in rows
    )


@cache
def street_keys(name: str) -> frozenset[str]:
    """'Lawndale / Cullen Blvd' -> {'LAWNDALE', 'CULLEN'}; 'W Holcombe Blvd' -> {'HOLCOMBE'}."""
    keys = set()
    for part in name.upper().split("/"):
        words = part.replace(".", " ").split()
        while words and words[-1] in _SUFFIXES | _DIRECTIONS:  # "Telephone Rd South"
            words.pop()
        while words and words[0] in _DIRECTIONS:
            words.pop(0)
        if words:
            keys.add(" ".join(words))
    return frozenset(keys)


def _dist_to_line_m(p: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
    """Metres from p to the segment a-b, all (lat, lng). Flat earth is fine at city scale."""
    ky, kx = 110_540.0, 111_320.0 * math.cos(math.radians(p[0]))
    ax, ay, bx, by = (a[1] - p[1]) * kx, (a[0] - p[0]) * ky, (b[1] - p[1]) * kx, (b[0] - p[0]) * ky
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) if dx or dy else 0.0
    return math.hypot(ax + t * dx, ay + t * dy)


def _dist_to_shape_m(p: tuple[float, float], shape) -> float:
    return min(_dist_to_line_m(p, tuple(a), tuple(b)) for a, b in zip(shape, shape[1:]))


def match(name: str, shape) -> list[HinSegment]:
    """HIN rows on the street `name` near the road shape (a list of [lat, lng])."""
    keys = street_keys(name)
    return [
        s
        for s in hin_segments()
        if street_keys(s.name) & keys and _dist_to_shape_m((s.lat, s.lng), shape) <= MATCH_RADIUS_M
    ]


@cache
def citywide_rate() -> float:
    """Average crashes per mile over the whole HIN."""
    segs = hin_segments()
    return sum(s.crashes for s in segs) / sum(s.miles for s in segs)


@cache
def crash_factor(name: str, shape: tuple[tuple[float, float], ...]) -> float:
    """How much more crash-prone this street link is than a typical street: 1 + its HIN crashes
    per mile / the HIN average, capped at MAX_FACTOR. 1.0 if it's not on the HIN. Being on the
    HIN at all puts a street above a typical one, so a matched link never comes out below 1."""
    hits = match(name, shape)
    if not hits:
        return 1.0
    rate = sum(s.crashes for s in hits) / sum(s.miles for s in hits)
    return min(MAX_FACTOR, 1 + rate / citywide_rate())
