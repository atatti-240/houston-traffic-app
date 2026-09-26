"""THROWAWAY SPIKE — can the 5 must-haves actually work, and does the plan beat a
"Google/Apple-style" baseline?  Not product code.

Must-haves tested:
  1. Train Watch crossing map
  2. YOLO car counts on ~20 cameras near Ion
  3. 3-stop planner with time windows
  4. Re-plan when a crossing blocks (+ alert text)
  5. Replay mode (save state, re-run from file)

Honest limits of the comparison:
  - We have no Google/Apple API key, so the baseline is a PROXY: same traffic model,
    but stops visited in the order typed, leave now, no crossing awareness.
    That mimics what the Maps apps do with a typed multi-stop list.
  - Real proof needs actual drives (or Google ETAs) logged against our predictions.

Run:  spikes/.venv/Scripts/python spikes/must_have_test.py
"""
import itertools, json, math, re, time, urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).parent
CDT = timezone(timedelta(hours=-5))
UA = {"User-Agent": "Mozilla/5.0 (hackathon spike)"}

START = ("Ion District", 29.7336, -95.3790)
# (name, lat, lng, window_start_min, window_end_min) — minutes from now
STOPS = [
    ("East End / Commerce St", 29.7590, -95.3440, 0, 240),  # route crosses Commerce St tracks
    ("Texas Medical Center", 29.7070, -95.3980, 60, 180),
    ("Houston Heights", 29.7980, -95.3980, 0, 240),
]
DWELL_MIN = 30          # time spent at each stop
DEPART_OFFSETS = range(0, 121, 15)
CROSSING_BUFFER_M = 60  # crossing counts as "on route" if this close
CAMERA_BUFFER_M = 300


def get(url, raw=False):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
        body = r.read()
    return body if raw else json.loads(body)


def meters(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 6371000 * 2 * math.asin(math.sqrt(h))


def dist_to_line(p, line):
    """min distance (m) from point p=(lat,lng) to polyline [(lat,lng),...]"""
    k = 111320 * math.cos(math.radians(p[0]))
    best = 1e18
    for (a, b) in zip(line, line[1:]):
        ax, ay = (a[1] - p[1]) * k, (a[0] - p[0]) * 110540
        bx, by = (b[1] - p[1]) * k, (b[0] - p[0]) * 110540
        dx, dy = bx - ax, by - ay
        t = 0 if dx == dy == 0 else max(0, min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy)))
        best = min(best, math.hypot(ax + t * dx, ay + t * dy))
    return best


# ---------------------------------------------------------------- data pulls
def pull_crossings():
    url = ("https://services.arcgis.com/NummVBqZSIJKUeVR/arcgis/rest/services/Train_Watch_Layer/FeatureServer/0/query"
           "?where=1%3D1&outFields=street,crossingStatus,sensorStatus,timeToClear,predictedStart,trainTravelDirection"
           "&outSR=4326&f=json")
    out = []
    for f in get(url)["features"]:
        a, g = f["attributes"], f["geometry"]
        out.append({**a, "lat": g["y"], "lng": g["x"]})
    return out


def pull_cameras():
    js = get("https://traffic.houstontranstar.org/data/layers/cctvSnapshots_out.js", raw=True).decode("utf-8", "ignore")
    pat = re.compile(r"new CctvCamera\('([^']*)','[^']*','([^']*)','[^']*','([-\d.]+)','([-\d.]+)','[^']*','([^']*)'")
    return [{"name": n, "road": r, "lat": float(la), "lng": float(lo), "path": p} for n, r, la, lo, p in pat.findall(js)]


def pull_history_multipliers():
    """TranStar historical weekday travel times → avg (travel / free-flow) per 15-min slot."""
    ratios = {}
    for rid in range(1, 7):
        html = get(f"https://traffic.houstontranstar.org/hist/traveltimes_web.aspx?id={rid}&year=2025", raw=True).decode("utf-8", "ignore")
        text = re.sub(r"<[^>]+>", " ", html)
        text = re.sub(r"\s+", " ", text)
        for half in re.split(r"(?=[AP]M Summary)", text)[1:]:
            ff = re.search(r"Without Delay (\d+):(\d\d)", half)
            if not ff:
                continue
            free = int(ff[1]) * 60 + int(ff[2])
            for slot, m, s in re.findall(r"(\d{1,2}:\d\d [AP]M)-\d{1,2}:\d\d [AP]M (\d+):(\d\d) \d+", half):
                ratios.setdefault(slot, []).append((int(m) * 60 + int(s)) / free)
    return {k: sum(v) / len(v) for k, v in ratios.items()}


def slot_key(dt):
    dt = dt.replace(minute=dt.minute - dt.minute % 15)
    return dt.strftime("%I:%M %p").lstrip("0")


def pull_osrm(points):
    coords = ";".join(f"{p[2]},{p[1]}" for p in points)
    table = get(f"https://router.project-osrm.org/table/v1/driving/{coords}?annotations=duration")["durations"]
    geoms = {}
    for i, j in itertools.permutations(range(len(points)), 2):
        a, b = points[i], points[j]
        r = get(f"https://router.project-osrm.org/route/v1/driving/{a[2]},{a[1]};{b[2]},{b[1]}?overview=full&geometries=geojson")
        geoms[f"{i}-{j}"] = [(c[1], c[0]) for c in r["routes"][0]["geometry"]["coordinates"]]
        time.sleep(0.2)
    return table, geoms


def yolo_counts(cams):
    from ultralytics import YOLO
    model = YOLO("yolov8n.pt")
    snap_dir = HERE / "snapshots"
    snap_dir.mkdir(exist_ok=True)
    out = {}
    for c in cams:
        f = snap_dir / c["path"]
        try:
            f.write_bytes(get(f"https://www.houstontranstar.org/snapshots/cctv/{c['path']}", raw=True))
            res = model(str(f), classes=[2, 3, 5, 7], conf=0.25, verbose=False)[0]
            out[c["path"]] = len(res.boxes)
        except Exception as e:
            out[c["path"]] = None
            print(f"    camera {c['name']}: {type(e).__name__}")
    return out


# ---------------------------------------------------------------- planner
def parse_clear(s):
    m = re.search(r"(\d+)", s or "")
    return int(m[1]) if m else 10


def crossings_on(geom, crossings):
    return [c for c in crossings if dist_to_line((c["lat"], c["lng"]), geom) <= CROSSING_BUFFER_M]


def leg_minutes(state, i, j, depart, now):
    base = state["table"][i][j] / 60
    mult = state["mult"].get(slot_key(depart), 1.0)
    penalty, notes = 0.0, []
    for c in crossings_on(state["geoms"][f"{i}-{j}"], state["crossings"]):
        if c["sensorStatus"] != "UP":  # a down sensor's "blocked"/"clear" may be stale → don't trust it
            notes.append(f"{c['street']} crossing UNKNOWN (sensor down, reports '{c['crossingStatus']}')")
        elif c["crossingStatus"] == "blocked" and depart - now < timedelta(minutes=parse_clear(c["timeToClear"]) + 5):
            wait = max(0, parse_clear(c["timeToClear"]) - (depart - now).total_seconds() / 60)
            penalty += wait
            notes.append(f"train blocking {c['street']} (+{wait:.0f} min)")
    return base * mult + penalty, notes


def simulate(state, order, offset, now):
    t = now + timedelta(minutes=offset)
    here, drive, wait, notes, late = 0, 0.0, 0.0, [], []
    legs = []
    for k in order:
        mins, n = leg_minutes(state, here, k + 1, t, now)
        legs.append((here, k + 1, t, mins))
        drive += mins
        notes += n
        t += timedelta(minutes=mins)
        name, _, _, ws, we = STOPS[k]
        rel = (t - now).total_seconds() / 60
        if rel < ws:
            wait += ws - rel
            t = now + timedelta(minutes=ws)
        elif rel > we:
            late.append(name)
        t += timedelta(minutes=DWELL_MIN)
        here = k + 1
    return {"order": order, "offset": offset, "drive": drive, "wait": wait, "finish": t, "late": late, "notes": notes, "legs": legs}


DELAY_WEIGHT = 0.3  # 1 min of leaving later "costs" 0.3 min — people don't want to sit around for hours


def best_plan(state, now, offsets=DEPART_OFFSETS):
    plans = [simulate(state, o, off, now) for o in itertools.permutations(range(len(STOPS))) for off in offsets]
    ok = [p for p in plans if not p["late"]] or plans
    return min(ok, key=lambda p: (p["drive"] + 0.5 * p["wait"] + DELAY_WEIGHT * p["offset"], p["finish"]))


def show(label, p):
    names = " → ".join(STOPS[k][0] for k in p["order"])
    print(f"  {label}: leave +{p['offset']} min | {names}")
    print(f"      drive {p['drive']:.0f} min, wait {p['wait']:.0f} min, finish {p['finish']:%I:%M %p}, "
          f"late at: {p['late'] or 'none'}")
    for n in sorted(set(p["notes"])):
        print(f"      ! {n}")


# ---------------------------------------------------------------- run
def main():
    now = datetime.now(CDT).replace(second=0, microsecond=0)
    results = {}
    print(f"Spike run {now:%Y-%m-%d %I:%M %p} CDT\n")

    print("[1] Train Watch crossing map")
    crossings = pull_crossings()
    up = sum(c["sensorStatus"] == "UP" for c in crossings)
    blocked = [c["street"] for c in crossings if c["crossingStatus"] == "blocked"]
    print(f"    {len(crossings)} crossings, sensors up {up}, blocked now: {blocked or 'none'}")
    results["1 crossing map"] = len(crossings) > 0

    print("[2] YOLO car counts, 20 cameras nearest Ion")
    cams = sorted(pull_cameras(), key=lambda c: meters((START[1], START[2]), (c["lat"], c["lng"])))[:20]
    t0 = time.time()
    counts = yolo_counts(cams)
    good = [v for v in counts.values() if v is not None]
    for c in cams[:5]:
        print(f"    {c['name']:<38} cars={counts[c['path']]}")
    print(f"    ... {len(good)}/20 analysed in {time.time() - t0:.0f}s, avg {sum(good) / max(1, len(good)):.1f} vehicles/frame")
    results["2 YOLO counts"] = len(good) >= 15

    print("[3] 3-stop planner with time windows")
    points = [START] + [s[:3] for s in STOPS]
    table, geoms = pull_osrm(points)
    mult = pull_history_multipliers()
    print(f"    history multipliers for {len(mult)} slots; now ({slot_key(now)}) = {mult.get(slot_key(now), 1.0):.2f}x")
    state = {"crossings": crossings, "table": table, "geoms": geoms, "mult": mult, "counts": counts}
    ours = best_plan(state, now)
    ours_now = best_plan(state, now, offsets=[0])  # reorder only, still leave now
    baseline = simulate(state, tuple(range(len(STOPS))), 0, now)
    show("BASELINE (typed order, leave now)", baseline)
    show("OURS: reorder only, leave now    ", ours_now)
    show("OURS: best order + best time     ", ours)
    on_route = {c["street"] for leg in geoms.values() for c in crossings_on(leg, crossings)}
    print(f"    Train Watch crossings touched by any leg: {sorted(on_route) or 'none'}")
    results["3 planner"] = not ours["late"]

    print("[4] Re-plan when a crossing blocks")
    first = ours["legs"][0]
    hit = crossings_on(geoms[f"{first[0]}-{first[1]}"], crossings)
    target = hit[0] if hit else None
    if not target:  # no crossing on first leg → block one on any leg of our plan
        for a, b, _, _ in ours["legs"]:
            hit = crossings_on(geoms[f"{a}-{b}"], crossings)
            if hit:
                target = hit[0]
                break
    if target:
        sim = {**state, "crossings": [dict(c, crossingStatus="blocked", sensorStatus="UP", timeToClear="60 MIN") if c is target else c for c in crossings]}
        before = simulate(sim, ours["order"], ours["offset"], now)
        after = best_plan(sim, now)
        print(f"    simulated: working sensor reports train blocking {target['street']} for 60 min")
        show("OLD PLAN", before)
        show("RE-PLAN ", after)
        saved = (before["drive"] + before["wait"]) - (after["drive"] + after["wait"])
        changed = (after["order"], after["offset"]) != (before["order"], before["offset"])
        print(f"    ALERT → " + (f"'Change plan: leave +{after['offset']} min via new order, saves {saved:.0f} min'" if changed else "'No change needed'"))
        hit_block = any("train blocking" in n for n in before["notes"])
        results["4 re-plan"] = hit_block and (changed or after["drive"] + after["wait"] <= before["drive"] + before["wait"])
    else:
        print("    no Train Watch crossing on any planned leg → cannot test re-plan with these stops")
        results["4 re-plan"] = False

    print("[5] Replay mode")
    rp = HERE / "replay"
    rp.mkdir(exist_ok=True)
    f = rp / f"state_{now:%Y%m%d_%H%M}.json"
    f.write_text(json.dumps({"now": now.isoformat(), **state}))
    loaded = json.loads(f.read_text())
    loaded["geoms"] = {k: [tuple(p) for p in v] for k, v in loaded["geoms"].items()}
    again = best_plan(loaded, datetime.fromisoformat(loaded["now"]))
    same = (again["order"], again["offset"]) == (tuple(ours["order"]), ours["offset"])
    print(f"    saved {f.name} ({f.stat().st_size // 1024} KB); replay gives same plan: {same}")
    results["5 replay"] = same

    print("\n=== RESULT ===")
    for k, v in results.items():
        print(f"  {'PASS' if v else 'FAIL'}  {k}")
    print("\n=== vs Google/Apple-style baseline (proxy, same traffic model) ===")
    b = baseline["drive"] + baseline["wait"]
    print(f"  saved by reordering only (leave now): {b - ours_now['drive'] - ours_now['wait']:.0f} min")
    print(f"  saved by reorder + best leave time:   {b - ours['drive'] - ours['wait']:.0f} min driving "
          f"(but leaves {ours['offset']} min later; finish {ours['finish']:%I:%M %p} vs {baseline['finish']:%I:%M %p})")
    print(f"  late stops — baseline: {baseline['late'] or 'none'} | ours: {ours['late'] or 'none'}")
    url = "https://www.google.com/maps/dir/" + "/".join(f"{p[1]},{p[2]}" for p in [START] + [STOPS[k] for k in ours['order']])
    print(f"  compare manually in Google Maps (our order): {url}")


if __name__ == "__main__":
    main()
