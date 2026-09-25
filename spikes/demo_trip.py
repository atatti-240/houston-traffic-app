"""THROWAWAY DEMO — "UH Sugar Land -> UH main campus by ~5 PM -> Ion District by 6 PM:
when should I leave?"  Built only from data we've already tested.

Model (typical weekday):
  leg time(depart) = OSRM free-flow time x TranStar historical slowdown for that 15-min slot
  Leg 1 slowdown = US-59 Southwest inbound (TranStar routes 11 + 12, 2025 weekday averages)
  Leg 2 slowdown = average of 6 TranStar routes (no street-level history)
Plus: live TranStar RSS (right now), Train Watch crossings and Vision Zero crash segments on each route.

Run: spikes/.venv/Scripts/python spikes/demo_trip.py
"""
import json, re, xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from pathlib import Path

import must_have_test as m  # reuse spike helpers: get, dist_to_line, pull_crossings, slot_key

HERE = Path(__file__).parent
UH_SL = ("UH Sugar Land", 29.5747, -95.6480)
UH = ("UH main campus", 29.7199, -95.3422)
ION = ("Ion District", 29.7336, -95.3790)
ARRIVE_UH, ARRIVE_ION = "17:00", "18:00"
SPARE_MIN = 5            # want to arrive at least this early
SAFE_BUFFER = 0.15       # "safe" option adds 15% to the drive for bad days
DWELL_UH = 30            # max you'd stay at UH before heading to Ion


def hist_route(rid):
    """TranStar historical page -> (free-flow seconds, {slot: seconds})"""
    html = m.get(f"https://traffic.houstontranstar.org/hist/traveltimes_web.aspx?id={rid}&year=2025", raw=True).decode("utf-8", "ignore")
    text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html))
    ff = re.search(r"Without Delay (\d+):(\d\d)", text)
    slots = {s: int(mm) * 60 + int(ss) for s, mm, ss in re.findall(r"(\d{1,2}:\d\d [AP]M)-\d{1,2}:\d\d [AP]M (\d+):(\d\d) \d+", text)}
    return int(ff[1]) * 60 + int(ff[2]), slots


def osrm(a, b):
    r = m.get(f"https://router.project-osrm.org/route/v1/driving/{a[2]},{a[1]};{b[2]},{b[1]}?overview=full&geometries=geojson")["routes"][0]
    return r["duration"] / 60, r["distance"] / 1609, [(c[1], c[0]) for c in r["geometry"]["coordinates"]]


def at(day, hhmm):
    h, mi = map(int, hhmm.split(":"))
    return day.replace(hour=h, minute=mi, second=0, microsecond=0)


def main():
    day = datetime(2026, 9, 28)  # a typical weekday (Monday) — history is weekday averages
    print("Loading data...")
    ff11, s11 = hist_route(11)
    ff12, s12 = hist_route(12)
    mult1 = {k: (s11[k] + s12[k]) / (ff11 + ff12) for k in s11 if k in s12}
    mult2 = m.pull_history_multipliers()
    leg1_ff, leg1_mi, g1 = osrm(UH_SL, UH)
    leg2_ff, leg2_mi, g2 = osrm(UH, ION)
    drive = lambda ff, mult, t: ff * mult.get(m.slot_key(t), 1.0)

    print(f"\nLeg 1  {UH_SL[0]} -> {UH[0]}: {leg1_mi:.1f} mi, {leg1_ff:.0f} min with no traffic")
    print(f"Leg 2  {UH[0]} -> {ION[0]}: {leg2_mi:.1f} mi, {leg2_ff:.0f} min with no traffic")

    # ---- leg 1: scan departures 3:00-4:45 every 5 min
    target = at(day, ARRIVE_UH) - timedelta(minutes=SPARE_MIN)
    print(f"\nLeg 1 departure scan (typical weekday, arrive by {ARRIVE_UH}):")
    print(f"  {'leave':>7} {'drive':>6} {'arrive':>7} {'safe arrive':>12}  slowdown")
    best = safe = None
    t = at(day, "15:00")
    while t <= at(day, "16:45"):
        d = drive(leg1_ff, mult1, t)
        arr, arr_safe = t + timedelta(minutes=d), t + timedelta(minutes=d * (1 + SAFE_BUFFER))
        ok = "ok" if arr <= target else "LATE"
        if t.minute % 15 == 0:
            print(f"  {t:%I:%M %p} {d:5.0f}m {arr:%I:%M %p} {arr_safe:%I:%M %p}     {mult1.get(m.slot_key(t), 1):.2f}x  {ok}")
        if arr <= target:
            best = (t, d, arr)
        if arr_safe <= target:
            safe = (t, d, arr_safe)
        t += timedelta(minutes=5)

    # ---- leg 2: leave UH so you reach Ion by 6
    t2, d2 = None, None
    t = at(day, "17:00")
    while t <= at(day, "17:55"):
        d = drive(leg2_ff, mult2, t)
        if t + timedelta(minutes=d * (1 + SAFE_BUFFER)) <= at(day, ARRIVE_ION) - timedelta(minutes=SPARE_MIN):
            t2, d2 = t, d
        t += timedelta(minutes=5)

    # ---- hazards on route
    crossings = m.pull_crossings()
    hin = json.load(open(HERE / "hin2025_segments.json")) if (HERE / "hin2025_segments.json").exists() else []
    def hazards(g):
        cx = [c["street"] for c in crossings if m.dist_to_line((c["lat"], c["lng"]), g) <= 60]
        hs = sorted({(r["Full_Name"], r["Total_Crash_Count"], r["Total_Death_Count"]) for r in hin
                     if m.dist_to_line((r["lat"], r["lng"]), g) <= 40}, key=lambda x: -x[1])
        return cx, hs

    # ---- live right now
    root = ET.fromstring(m.get("https://traffic.houstontranstar.org/data/rss/traveltimes_rss.xml", raw=True))
    live = [(i.findtext("title"), i.findtext("description")) for i in root.iter("item")
            if re.search(r"(US-59|IH-69) Southwest (Northbound|Inbound)", i.findtext("title") or "")]
    inc = ET.fromstring(m.get("https://traffic.houstontranstar.org/data/rss/incidents_rss.xml", raw=True))
    inc59 = [i.findtext("title") for i in inc.iter("item") if re.search(r"(US-59|IH-69) Southwest|288|Fannin|Main", i.findtext("title") or "")]

    print("\n================ RECOMMENDATION ================")
    if best:
        print(f"  Leave UH Sugar Land by {best[0]:%I:%M %p}  (drive ~{best[1]:.0f} min, arrive ~{best[2]:%I:%M %p})")
    if safe:
        print(f"  Safer: leave by {safe[0]:%I:%M %p}  (arrive by {safe[2]:%I:%M %p} even if traffic is 15% worse)")
    if t2:
        print(f"  Then leave UH main by {t2:%I:%M %p}  (drive ~{d2:.0f} min) -> Ion District before 6:00 PM")
    for label, g in (("Leg 1", g1), ("Leg 2", g2)):
        cx, hs = hazards(g)
        print(f"  {label} rail crossings (Train Watch): {cx or 'none'}")
        for name, c, dth in hs[:3]:
            print(f"  {label} high-injury segment: {name} ({c} severe crashes, {dth} deaths)")
    print("\n  Live right now (TranStar RSS):")
    for title, desc in live[:4]:
        print(f"    {title}: {desc}")
    print(f"    incidents on/near the route: {inc59[:3] or 'none'}")
    print(f"\n  Google Maps to compare: https://www.google.com/maps/dir/{UH_SL[1]},{UH_SL[2]}/{UH[1]},{UH[2]}/{ION[1]},{ION[2]}")


if __name__ == "__main__":
    main()
