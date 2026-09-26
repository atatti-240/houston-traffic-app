"""THROWAWAY SPIKE — summarize spikes/data/log.db.
Run: spikes/.venv/Scripts/python spikes/log_report.py
"""
import sqlite3, statistics
from datetime import datetime
from pathlib import Path

db = sqlite3.connect(Path(__file__).parent / "data" / "log.db")
q = lambda s, *a: db.execute(s, a).fetchall()

first, last = q("select min(ts), max(ts) from frames")[0]
print(f"Logged {first} -> {last}\n")

print("=== Camera refresh intervals (seconds between NEW images) ===")
rows = q("select cam, name, secs_since_change from frames where changed=1 and secs_since_change is not null")
gaps = {}
for cam, name, s in rows:
    gaps.setdefault((cam, name), []).append(s)
polled = {c: n for c, n in q("select cam, count(*) from frames group by cam")}
never = [(c, n) for c, n in q("select cam, name from frames group by cam having sum(changed) <= 1")]
meds = sorted(((statistics.median(v), len(v), k) for k, v in gaps.items()))
if meds:
    allm = [m for m, _, _ in meds]
    print(f"  {len(meds)} cameras refreshed; median of medians {statistics.median(allm):.0f}s, fastest {allm[0]:.0f}s, slowest {allm[-1]:.0f}s")
    for m, n, (cam, name) in meds[:3] + meds[-3:]:
        print(f"    {name:<40} median {m:5.0f}s over {n} refreshes")
print(f"  {len(never)} cameras never changed while polled (frozen or slow):")
for cam, name in never[:10]:
    print(f"    {name} ({cam}, polled {polled[cam]}x)")

print("\n=== Invalid snapshots ===")
for cam, name, reason, n in q("select cam, name, reason, count(*) from frames where valid=0 group by cam, reason"):
    print(f"  {name:<40} {reason} x{n}")

print("\n=== YOLO car counts (latest per camera, top 8) ===")
for name, cars, ts in q("""select name, cars, max(ts) from frames where cars is not null group by cam order by cars desc limit 8"""):
    print(f"  {name:<40} {cars} vehicles  ({ts})")

print("\n=== Crossing blockages (sessions) ===")
sessions, open_ = [], {}
for ts, street, status, sensor in q("select ts, street, status, sensor from crossings order by ts"):
    if status == "blocked" and street not in open_:
        open_[street] = (ts, sensor)
    elif status != "blocked" and street in open_:
        s, sen = open_.pop(street)
        sessions.append((street, s, ts, sen))
dur = lambda a, b: (datetime.fromisoformat(b) - datetime.fromisoformat(a)).total_seconds() / 60
for street, s, e, sen in sessions:
    print(f"  {street:<28} {s[11:16]}->{e[11:16]} UTC  {dur(s, e):5.1f} min  (sensor {sen})")
for street, (s, sen) in open_.items():
    print(f"  {street:<28} {s[11:16]}-> still blocked  (sensor {sen})")
print(f"  total sessions: {len(sessions)} closed, {len(open_)} open")

print("\n=== RSS ===")
for feed, n, t in q("select feed, count(distinct title), count(distinct ts) from rss group by feed"):
    print(f"  {feed:<13} {n} distinct items over {t} polls")
print(f"\nErrors logged: {q('select count(*) from errors')[0][0]}")
