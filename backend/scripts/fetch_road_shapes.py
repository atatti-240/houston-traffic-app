"""Trace every road segment along the real streets, from OpenStreetMap via the public OSRM router.

Writes app/seed/road_shapes.json: {segment_id: [[lat, lng], ...]} plus each rail crossing
snapped onto its street. seed_network() draws segments with these shapes when the file exists
(and falls back to straight lines otherwise), so the app itself never calls OSRM.

    cd backend && uv run python scripts/fetch_road_shapes.py [--check]

Road data (c) OpenStreetMap contributors, ODbL. The public OSRM demo server asks for at most
one request per second; this makes ~90.
"""

import json
import math
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.seed.network import LINKS, iter_directed, node_latlng, segment_id  # noqa: E402

OSRM = "https://router.project-osrm.org/route/v1/driving/"
OUT = Path(__file__).resolve().parents[1] / "app" / "seed" / "road_shapes.json"
SIMPLIFY_M = 12  # drop points closer than this to the line (keeps the file small)

# Freeways are traced end to end (a long trip stays on the freeway, a short hop between two
# approximate interchange points often doesn't), then cut at the nodes along them.
# code(s) -> the corridor's nodes in order; routed from the first to the last (and back).
CORRIDORS: list[tuple[tuple[str, ...], list[str]]] = [
    (("I45N",), ["downtown", "i45_610n", "i45_bw8n", "greenspoint"]),
    (("I45S",), ["downtown", "gulf_ee", "i45_610s", "hobby"]),
    (("I10W", "I10E"), ["energy", "i10_bw8w", "i10_610w", "downtown", "i10_610e"]),
    (("I69",), ["downtown", "midtown", "i69_610sw", "i69_bw8sw"]),
    (("L610W", "L610S"), ["290_610nw", "i10_610w", "i69_610sw", "288_610s", "i45_610s"]),
    (("L610E", "L610N"), ["i45_610s", "i10_610e", "i45_610n", "290_610nw"]),
    (("SH288",), ["midtown", "tmc_288", "288_610s"]),
    (("US290",), ["290_610nw", "290_bw8"]),
    (("BW8",), ["i45_bw8n", "290_bw8", "i10_bw8w", "i69_bw8sw"]),
]
# Checkpoints that keep a route on its road, taken from the OpenStreetMap road lines (via
# OpenFreeMap tiles): the interchanges snapped onto the freeway, and points on each street.
# Keyed by the corridor's first link code, in the corridor's node order.
CORRIDOR_VIA: dict[str, list[tuple[float, float]]] = {
    "L610W": [(29.79521, -95.45127), (29.78369, -95.4522), (29.75732, -95.45576), (29.73239, -95.45982),
              (29.68104, -95.38488), (29.68677, -95.33741)],
    "L610E": [(29.73533, -95.26587), (29.77843, -95.26353), (29.80816, -95.33082), (29.81355, -95.39479),
              (29.81263, -95.42581)],
    "BW8": [(29.87187, -95.55994), (29.82635, -95.5639), (29.7796, -95.56288), (29.73747, -95.55753)],
}
# Surface streets: points on the street (any order; sorted from the link's `a` end).
STREET_VIA: dict[str, list[tuple[float, float]]] = {
    "WHMR": [(29.741, -95.45777)],
    "AIRL": [],
    "HOUAV": [(29.77275, -95.37239)],
    "QUIT": [(29.78119, -95.3627)],
    "IRV": [],
    "TELE": [],
    "WAYS": [(29.75474, -95.29627)],
    "CULL": [(29.72699, -95.31876)],
    "OST": [],
    "TELS": [],
    "SCOT": [(29.72478, -95.35047)],
}
# Rail crossings moved onto their street (the seeded points are approximate).
CROSSING_AT: dict[str, tuple[float, float]] = {
    "x_houston_ave": (29.78005, -95.37248),
    "x_quitman": (29.78332, -95.35684),
    "x_irvington": (29.80133, -95.36094),
    "x_telephone": (29.73231, -95.32794),
    "x_wayside": (29.76086, -95.29459),
    "x_cullen": (29.7271, -95.34402),
    "x_ost": (29.7016, -95.37233),
    "x_telephone_s": (29.70355, -95.30504),
}


def _bearing(a, b) -> int:
    dy = b[0] - a[0]
    dx = (b[1] - a[1]) * math.cos(math.radians(a[0]))
    return round((math.degrees(math.atan2(dx, dy)) + 360) % 360) % 360


def _route(points: list[tuple[float, float]], directed: bool = False) -> dict:
    """`directed`: make each checkpoint be passed in the direction of travel (the right
    carriageway of a divided freeway), taken from the points before and after it."""
    coords = ";".join(f"{lng:.6f},{lat:.6f}" for lat, lng in points)
    url = f"{OSRM}{coords}?overview=full&geometries=geojson&steps=true"
    if directed and len(points) > 2:
        mids = [f"{_bearing(points[i - 1], points[i + 1])},60" for i in range(1, len(points) - 1)]
        url += "&bearings=;" + ";".join(mids) + ";"
    req = urllib.request.Request(url, headers={"User-Agent": "blindspot-houston-hackathon/1.0"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                body = json.load(r)
            if body.get("code") != "Ok":
                raise RuntimeError(body.get("message") or body.get("code"))
            return body
        except Exception:
            if attempt == 3:
                raise
            time.sleep(2 * (attempt + 1))
    raise AssertionError("unreachable")


def _dist_m(a, b) -> float:
    k = math.cos(math.radians((a[0] + b[0]) / 2))
    return math.hypot((a[0] - b[0]) * 111_320, (a[1] - b[1]) * 111_320 * k)


def _project(p, line: list[list[float]]) -> list[float]:
    """The point on a line closest to p."""
    k = math.cos(math.radians(p[0]))
    best, at = math.inf, list(line[0])
    for a, b in zip(line, line[1:]):
        ax, ay, bx, by = a[1] * k, a[0], b[1] * k, b[0]
        dx, dy = bx - ax, by - ay
        t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((p[1] * k - ax) * dx + (p[0] - ay) * dy) / (dx * dx + dy * dy)))
        q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
        d = _dist_m(p, q)
        if d < best:
            best, at = d, q
    return [round(at[0], 6), round(at[1], 6)]


def _despur(pts: list[list[float]], near_m: float = 12) -> list[list[float]]:
    """Cut out-and-back spurs and small loops (a route driving to a checkpoint and turning around):
    when the line comes back to a point it already passed, drop what's in between."""
    out: list[list[float]] = []
    for p in pts:
        back = next((i for i in range(len(out) - 2, -1, -1) if _dist_m(out[i], p) < near_m), None)
        if back is not None:
            del out[back + 1 :]
            continue
        out.append(p)
    return out


def _simplify(pts: list[list[float]], tol: float) -> list[list[float]]:
    """Douglas-Peucker in meters."""
    if len(pts) < 3:
        return pts

    def perp(p, a, b):
        k = math.cos(math.radians(a[0]))
        ax, ay = a[1] * 111_320 * k, a[0] * 111_320
        bx, by = b[1] * 111_320 * k, b[0] * 111_320
        px, py = p[1] * 111_320 * k, p[0] * 111_320
        dx, dy = bx - ax, by - ay
        if dx == dy == 0:
            return math.hypot(px - ax, py - ay)
        t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
        return math.hypot(px - (ax + t * dx), py - (ay + t * dy))

    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        best, idx = 0.0, None
        for m in range(i + 1, j):
            d = perp(pts[m], pts[i], pts[j])
            if d > best:
                best, idx = d, m
        if idx is not None and best > tol:
            keep[idx] = True
            stack += [(i, idx), (idx, j)]
    return [p for p, k in zip(pts, keep) if k]


def _road_names(route: dict) -> str:
    names: dict[str, float] = {}
    for leg in route["legs"]:
        for st in leg["steps"]:
            label = st.get("ref") or st.get("name") or "?"
            names[label] = names.get(label, 0) + st["distance"]
    top = sorted(names.items(), key=lambda kv: -kv[1])[:3]
    return ", ".join(f"{n} {d / 1000:.1f}" for n, d in top)


def _points(route: dict) -> list[list[float]]:
    return [[round(lat, 6), round(lng, 6)] for lng, lat in route["geometry"]["coordinates"]]


def _cut(line: list[list[float]], nodes: list[str]) -> list[list[list[float]]]:
    """Split a traced corridor at the vertex nearest each node (in order along the line)."""
    idx = [0]
    for n in nodes[1:-1]:
        p = node_latlng(n)
        lo = idx[-1]
        best = min(range(lo, len(line)), key=lambda i: _dist_m(line[i], p))
        idx.append(best)
    idx.append(len(line) - 1)
    return [line[i : j + 1] for i, j in zip(idx, idx[1:])]


def _link(codes: tuple[str, ...], a: str, b: str):
    return next(lk for lk in LINKS if lk.code in codes and {lk.a, lk.b} == {a, b})


def main(check_only: bool = False) -> None:
    shapes: dict[str, list[list[float]]] = {}
    crossings: dict[str, list[float]] = {}
    report = []

    for codes, nodes in CORRIDORS:
        for seq in (nodes, list(reversed(nodes))):
            via = CORRIDOR_VIA.get(codes[0], [])
            if seq is not nodes:
                via = list(reversed(via))
            route = _route([node_latlng(seq[0]), *via, node_latlng(seq[-1])], directed=True)["routes"][0]
            report.append(f"{'/'.join(codes):12} {seq[0]:>11} -> {seq[-1]:<11} {route['distance'] / 1000:5.1f} km  {_road_names(route)}")
            for (frm, to), piece in zip(zip(seq, seq[1:]), _cut(_points(route), seq)):
                shapes[segment_id(_link(codes, frm, to), frm, to)] = _simplify(_despur(piece), SIMPLIFY_M)
            time.sleep(1.05)

    for link, frm, to in iter_directed():
        sid = segment_id(link, frm, to)
        if sid in shapes:
            continue
        at = {c.id: CROSSING_AT.get(c.id, (c.lat, c.lng)) for c in link.crossings}
        via = sorted(STREET_VIA.get(link.code, []) + list(at.values()), key=lambda p: _dist_m(node_latlng(link.a), p))
        if frm != link.a:
            via = list(reversed(via))
        body = _route([node_latlng(frm), *via, node_latlng(to)])
        route = body["routes"][0]
        shapes[sid] = _simplify(_despur(_points(route)), SIMPLIFY_M)
        if frm == link.a:  # rail crossings: where the route actually passes (the snapped via point)
            for c in link.crossings:
                wp = next(w for w, v in zip(body["waypoints"][1:-1], via) if v == at[c.id])
                # where the route snapped it, then onto the final (de-spurred) line
                crossings[c.id] = _project([wp["location"][1], wp["location"][0]], shapes[sid])
        straight = _dist_m(node_latlng(frm), node_latlng(to))
        report.append(f"{sid:34} {route['distance'] / 1000:5.1f} km (x{route['distance'] / max(straight, 1):.2f})  {_road_names(route)}")
        time.sleep(1.05)

    missing = [segment_id(lk, f, t) for lk, f, t in iter_directed() if segment_id(lk, f, t) not in shapes]
    print("\n".join(report))
    assert not missing, f"no shape for {missing}"
    if check_only:
        return
    OUT.write_text(
        json.dumps(
            {
                "source": "OpenStreetMap contributors (ODbL), routed with OSRM",
                "segments": shapes,
                "crossings": crossings,
            },
            separators=(",", ":"),
        )
    )
    n = sum(len(v) for v in shapes.values())
    print(f"wrote {OUT} ({len(shapes)} segments, {n} points, {OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main(check_only="--check" in sys.argv)
