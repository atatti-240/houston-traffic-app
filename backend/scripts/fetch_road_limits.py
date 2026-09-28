"""Look up each road segment's speed limit and toll status in OpenStreetMap, via Nominatim.

Samples points along each segment's traced road (app/seed/road_shapes.json) and asks Nominatim
which road is there (reverse lookup, zoom 17, with the road's OSM tags). A lookup counts only
when the answer is the segment's own road: for a freeway, its main lanes (motorway/trunk with
the right route number or name), not a ramp, frontage road, cross street or tolled managed/HOV
lane. Per segment it keeps the most common maxspeed and calls it a toll road only when most of
its main-lane lookups say toll=yes. Writes app/seed/road_limits.json with the votes, so every
value can be checked. No maxspeed in the data = unknown (null): the app never makes one up.

    cd backend && uv run python scripts/fetch_road_limits.py [--check] [--cache PATH]

Road data (c) OpenStreetMap contributors, ODbL. Nominatim's usage policy: at most one request
per second and an identifying User-Agent. This makes ~300 requests (about 6 min); answers are
cached (--cache, default in the temp folder) so a re-run only asks for points it hasn't seen.
Divided freeways are looked up per direction (each carriageway is its own OSM way); surface
streets once, for both directions.
"""

import json
import math
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.seed.network import LinkDef, haversine_m, iter_directed, road_shapes, segment_id  # noqa: E402

NOMINATIM = "https://nominatim.openstreetmap.org/reverse"
USER_AGENT = "blindspot-houston-hackathon/1.0 (one-off speed limit lookup; github.com/atatti-240/houston-traffic-app)"
OUT = Path(__file__).resolve().parents[1] / "app" / "seed" / "road_limits.json"
CACHE = Path(tempfile.gettempdir()) / "blindspot_nominatim_reverse.json"
PAUSE_S = 1.1  # Nominatim: one request per second, at most

FREEWAY_TYPES = {"motorway", "trunk"}
STREET_TYPES = {"trunk", "primary", "secondary", "tertiary", "unclassified", "residential"}
# Ways next to (or in the middle of) a freeway that aren't its main lanes.
SIDE_ROADS = re.compile(r"managed|\bhov\b|\bhot\b|express|frontage|feeder|service|access road", re.I)
# Other route numbers the main lanes carry (OSM tags the Beltway's tolled main lanes "SHT").
REF_ALIASES = {"I69": {"US59"}, "BW8": {"SHT"}}
GENERIC = {
    "n", "s", "e", "w", "north", "south", "east", "west", "st", "street", "rd", "road", "blvd",
    "boulevard", "dr", "drive", "ave", "avenue", "fwy", "freeway", "loop", "the",
}


def _norm_ref(ref: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", ref.upper())


def _words(name: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", name.lower()) if w not in GENERIC}


def _long_name(name: str) -> str:
    return re.sub(r"\bFwy\b", "Freeway", name).lower()


def parse_mph(value: str | None) -> int | None:
    """OSM maxspeed -> mph. Only explicit "NN mph" (US limits are posted in mph; a bare number
    would mean km/h, which on a Houston road is a tagging mistake). Anything else: unknown."""
    m = re.fullmatch(r"\s*(\d{2,3})\s*mph\s*", value or "")
    return int(m.group(1)) if m else None


def is_toll(tags: dict) -> bool:
    return tags.get("toll") == "yes" or tags.get("toll:motorcar") == "yes"


def _managed_lane(tags: dict) -> bool:
    """A reversible, HOV or otherwise restricted lane (Houston's tolled managed lanes are these),
    tagged with the freeway's own name and ref. Per-lane tags (hov:lanes) are on the main lanes."""
    return (
        tags.get("oneway") == "reversible"
        or any(k in tags for k in ("hov", "hov:minimum", "hov:conditional"))
        or tags.get("motor_vehicle") == "no"
        or tags.get("access") in {"no", "private"}
    )


def is_own_road(hit: dict | None, link: LinkDef) -> tuple[bool, str]:
    """Whether a Nominatim answer is the link's own road, and if not, what it hit instead."""
    if not hit or hit.get("category") != "highway":
        return False, "no road"
    kind = hit.get("type", "")
    name = hit.get("name") or ""
    tags = hit.get("extratags") or {}
    what = f"{name or 'unnamed'} ({kind})"
    if link.road_class == "freeway":
        refs = {_norm_ref(r) for r in ((hit.get("namedetails") or {}).get("ref") or "").split(";") if r.strip()}
        if kind not in FREEWAY_TYPES:
            return False, what
        if SIDE_ROADS.search(name) or _managed_lane(tags):
            return False, f"{what}, managed/HOV lane"
        want = {_norm_ref(link.highway)} | REF_ALIASES.get(link.code, set())
        names = [n for k, n in (hit.get("namedetails") or {}).items() if k in ("name", "loc_name", "alt_name")]
        if refs & want or any(_long_name(link.name) in _long_name(n) for n in names + [name]):
            return True, what
        return False, what
    if kind not in STREET_TYPES:
        return False, what
    keys = set().union(*(_words(part) for part in link.name.split("/"))) | _words(link.highway)
    if _words(name) & keys:
        return True, what
    return False, what


def decide(hits: list[dict | None], link: LinkDef) -> dict:
    """The segment's limit and toll status from its lookups, with the votes behind them."""
    own, skipped = [], []
    for hit in hits:
        ok, what = is_own_road(hit, link)
        (own if ok else skipped).append(hit if ok else what)
    speeds = Counter(parse_mph((h.get("extratags") or {}).get("maxspeed")) for h in own)
    known = {mph: n for mph, n in speeds.items() if mph is not None}
    # Most common posted limit; on a tie the lower one (never overstate a limit).
    limit = min(known, key=lambda mph: (-known[mph], mph)) if known else None
    tolls = sum(is_toll(h.get("extratags") or {}) for h in own)
    return {
        "speed_limit_mph": limit,
        "toll": bool(own) and tolls * 2 > len(own),  # main-lane majority
        "lookups": len(hits),
        "own_road": len(own),
        "speed_votes": {str(k): v for k, v in sorted(known.items())} | ({"none": speeds[None]} if speeds[None] else {}),
        "toll_votes": {"yes": tolls, "no": len(own) - tolls},
        "osm_ways": sorted({h["osm_id"] for h in own if "osm_id" in h}),
        "skipped": sorted(set(skipped)),
    }


def sample_points(line: list[list[float]], n: int) -> list[tuple[float, float]]:
    """n points spread evenly along a line, away from its ends (interchanges, ramps)."""
    lengths = [haversine_m(tuple(p), tuple(q)) for p, q in zip(line, line[1:])]
    total = sum(lengths)
    out = []
    for i in range(n):
        at, run = total * (i + 0.5) / n, 0.0
        for (p, q), d in zip(zip(line, line[1:]), lengths):
            if run + d >= at and d > 0:
                t = (at - run) / d
                out.append((round(p[0] + (q[0] - p[0]) * t, 6), round(p[1] + (q[1] - p[1]) * t, 6)))
                break
            run += d
    return out


def n_samples(link: LinkDef, km: float) -> int:
    if link.road_class == "freeway":
        return max(4, min(6, round(km / 2)))
    return max(3, min(5, round(km / 1.5)))


class Nominatim:
    def __init__(self, cache_path: Path) -> None:
        self.cache_path = cache_path
        self.cache: dict = json.loads(cache_path.read_text()) if cache_path.exists() else {}
        self.requests = 0

    def reverse(self, lat: float, lng: float) -> dict | None:
        key = f"{lat:.6f},{lng:.6f}"
        if key not in self.cache:
            self.cache[key] = self._get(lat, lng)
            self.requests += 1
            if self.requests % 10 == 0:
                self.save()
            time.sleep(PAUSE_S)
        hit = self.cache[key]
        return None if not hit or "error" in hit else hit

    def _get(self, lat: float, lng: float) -> dict:
        q = urllib.parse.urlencode(
            {"format": "jsonv2", "lat": f"{lat:.6f}", "lon": f"{lng:.6f}", "zoom": 17, "layer": "address",
             "extratags": 1, "namedetails": 1, "addressdetails": 0}
        )
        req = urllib.request.Request(f"{NOMINATIM}?{q}", headers={"User-Agent": USER_AGENT})
        err: Exception | None = None
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=20) as r:
                    return json.load(r)
            except urllib.error.HTTPError as e:
                if e.code in (403, 429):  # told to back off: stop instead of retrying
                    self.save()
                    raise SystemExit(f"Nominatim said {e.code}; stopping (answers so far are cached)") from e
                err = e
            except (OSError, ValueError) as e:  # down, timed out, or not JSON
                err = e
            time.sleep(5 * (attempt + 1))
        self.save()
        raise SystemExit(f"Nominatim isn't answering ({err}); stopping (answers so far are cached, run again to go on)")

    def save(self) -> None:
        self.cache_path.write_text(json.dumps(self.cache, separators=(",", ":")))


def main(check_only: bool = False, cache_path: Path = CACHE) -> None:
    api = Nominatim(cache_path)
    out: dict[str, dict] = {}
    report = []
    try:
        for link, frm, to in iter_directed():
            sid = segment_id(link, frm, to)
            if link.road_class != "freeway" and frm != link.a:
                # A surface street is one road both ways: share the forward lookups.
                out[sid] = out[segment_id(link, link.a, link.b)]
                continue
            line = road_shapes()["segments"][sid]  # the traced road itself, not pinned to the nodes
            km = sum(haversine_m(tuple(p), tuple(q)) for p, q in zip(line, line[1:])) / 1000
            hits = [api.reverse(lat, lng) for lat, lng in sample_points(line, n_samples(link, km))]
            out[sid] = decide(hits, link)
            r = out[sid]
            report.append(
                f"{sid:32} {r['speed_limit_mph'] or '?':>3} mph  toll={'Y' if r['toll'] else 'n'}  "
                f"own {r['own_road']}/{r['lookups']}  {r['speed_votes']}  {r['toll_votes']}"
                + (f"  skipped: {'; '.join(r['skipped'])}" if r["skipped"] else "")
            )
    finally:
        api.save()
    print("\n".join(report))
    known = sum(1 for r in out.values() if r["speed_limit_mph"])
    print(f"{api.requests} new lookups; {known}/{len(out)} segments with a known limit; "
          f"toll: {sorted({s.split(':')[0] for s, r in out.items() if r['toll']})}")
    if check_only:
        return
    lines = [f"  {json.dumps(sid)}: {json.dumps(r)}" for sid, r in sorted(out.items())]
    OUT.write_text(
        "{\n"
        '  "source": "OpenStreetMap contributors (ODbL), looked up with Nominatim (scripts/fetch_road_limits.py)",\n'
        '  "segments": {\n' + ",\n".join("  " + ln for ln in lines) + "\n  }\n}\n"
    )
    print(f"wrote {OUT}")


if __name__ == "__main__":
    args = sys.argv[1:]
    cache = Path(args[args.index("--cache") + 1]) if "--cache" in args else CACHE
    main(check_only="--check" in args, cache_path=cache)
