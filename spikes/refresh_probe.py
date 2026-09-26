"""THROWAWAY: how often do TranStar snapshots change? Polls 3 cameras every 15 s for 4 min."""
import hashlib, time, urllib.request
CAMS = ["504.jpg", "1002.jpg", "8048.jpg"]
last, changes, t0 = {}, {c: [] for c in CAMS}, time.time()
while time.time() - t0 < 240:
    for c in CAMS:
        req = urllib.request.Request(f"https://www.houstontranstar.org/snapshots/cctv/{c}", headers={"User-Agent": "Mozilla/5.0"})
        h = hashlib.md5(urllib.request.urlopen(req, timeout=20).read()).hexdigest()
        if last.get(c) != h:
            changes[c].append(round(time.time() - t0))
            last[c] = h
    time.sleep(15)
for c, ts in changes.items():
    gaps = [b - a for a, b in zip(ts, ts[1:])]
    print(f"{c}: changed at {ts} s  -> gaps {gaps}")
