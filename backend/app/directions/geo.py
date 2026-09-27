"""Small geometry helpers on [lat, lng] lines (meters, local flat-earth approximations)."""

import math
from bisect import bisect_right
from collections.abc import Sequence

M_PER_DEG = 111_320.0

Point = Sequence[float]  # [lat, lng]


def dist_m(a: Point, b: Point) -> float:
    k = math.cos(math.radians((a[0] + b[0]) / 2))
    return math.hypot((a[0] - b[0]) * M_PER_DEG, (a[1] - b[1]) * M_PER_DEG * k)


def bearing(a: Point, b: Point) -> int:
    """Compass bearing from a to b, 0-359 (0 = north)."""
    dy = b[0] - a[0]
    dx = (b[1] - a[1]) * math.cos(math.radians(a[0]))
    return round((math.degrees(math.atan2(dx, dy)) + 360) % 360) % 360


def angle_diff(a: float, b: float) -> float:
    """Smallest difference between two bearings, 0-180."""
    d = abs(a - b) % 360
    return 360 - d if d > 180 else d


def cumulative(line: Sequence[Point]) -> list[float]:
    """Distance along the line at each vertex."""
    out = [0.0]
    for a, b in zip(line, line[1:]):
        out.append(out[-1] + dist_m(a, b))
    return out


def project(p: Point, line: Sequence[Point], cum: Sequence[float] | None = None) -> tuple[float, float]:
    """(distance along the line of the point closest to p, how far p is from it)."""
    cum = cum if cum is not None else cumulative(line)
    k = math.cos(math.radians(p[0]))
    best, at = math.inf, 0.0
    for i, (a, b) in enumerate(zip(line, line[1:])):
        ax, ay, bx, by = a[1] * k, a[0], b[1] * k, b[0]
        dx, dy = bx - ax, by - ay
        den = dx * dx + dy * dy
        t = 0.0 if den == 0 else max(0.0, min(1.0, ((p[1] * k - ax) * dx + (p[0] - ay) * dy) / den))
        q = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
        d = dist_m(p, q)
        if d < best:
            best, at = d, cum[i] + (cum[i + 1] - cum[i]) * t
    return at, best


def point_at(line: Sequence[Point], cum: Sequence[float], d: float) -> list[float]:
    """The point `d` meters along the line."""
    if d <= 0:
        return list(line[0])
    if d >= cum[-1]:
        return list(line[-1])
    i = bisect_right(cum, d) - 1
    seg = cum[i + 1] - cum[i]
    t = 0.0 if seg == 0 else (d - cum[i]) / seg
    a, b = line[i], line[i + 1]
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]


def cut(line: Sequence[Point], cum: Sequence[float], d0: float, d1: float) -> list[list[float]]:
    """The part of the line between d0 and d1 meters along it."""
    if d1 <= d0:
        return [point_at(line, cum, d0)]
    out = [point_at(line, cum, d0)]
    out += [list(p) for p, c in zip(line, cum) if d0 < c < d1]
    out.append(point_at(line, cum, d1))
    return out


def simplify(pts: list[list[float]], tol_m: float) -> list[list[float]]:
    """Douglas-Peucker in meters (keeps the first and last point)."""
    if len(pts) < 3:
        return pts
    k = math.cos(math.radians(pts[0][0])) * M_PER_DEG
    xy = [(p[1] * k, p[0] * M_PER_DEG) for p in pts]

    def perp(m: int, i: int, j: int) -> float:
        (ax, ay), (bx, by), (px, py) = xy[i], xy[j], xy[m]
        dx, dy = bx - ax, by - ay
        den = dx * dx + dy * dy
        if den == 0:
            return math.hypot(px - ax, py - ay)
        t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / den))
        return math.hypot(px - (ax + t * dx), py - (ay + t * dy))

    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        best, idx = 0.0, None
        for m in range(i + 1, j):
            d = perp(m, i, j)
            if d > best:
                best, idx = d, m
        if idx is not None and best > tol_m:
            keep[idx] = True
            stack += [(i, idx), (idx, j)]
    return [p for p, kept in zip(pts, keep) if kept]


def doubles_back(line: Sequence[Point], near_m: float = 12.0, min_gap_m: float = 150.0) -> int | None:
    """Where (vertex index) the line comes back to a spot it already drove through and drives
    along the same road again, either way (an out-and-back spur, or a loop around a block): the
    telltale of a via point that snapped onto the wrong side of the road. None if it never does.
    Crossing its own path at an angle (an overpass, a loop ramp) is fine."""
    n = len(line)
    if n < 3:
        return None
    cum = cumulative(line)
    heads = [float(bearing(line[i], line[i + 1])) for i in range(n - 1)]

    def around(i: int) -> list[float]:  # heading into and out of vertex i
        return [heads[k] for k in (i - 1, i) if 0 <= k < n - 1]

    cell_lat = near_m / M_PER_DEG
    cell_lng = near_m / (M_PER_DEG * math.cos(math.radians(line[0][0])))
    grid: dict[tuple[int, int], list[int]] = {}
    for i, p in enumerate(line):
        gx, gy = int(p[0] // cell_lat), int(p[1] // cell_lng)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in grid.get((gx + dx, gy + dy), ()):
                    if cum[i] - cum[j] < min_gap_m or dist_m(line[j], p) > near_m:
                        continue
                    # Along the same road again (parallel or reversed), not across it.
                    skew = min(min(d, 180 - d) for a in around(i) for b in around(j) for d in [angle_diff(a, b)])
                    if skew < 35:
                        return i
        grid.setdefault((gx, gy), []).append(i)
    return None
