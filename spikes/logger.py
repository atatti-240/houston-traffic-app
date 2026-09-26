"""THROWAWAY SPIKE — weekend data logger. Collects the history our demo needs and
measures how often each TranStar camera actually refreshes.

Every 60 s : Train Watch crossings + camera snapshots (YOLO only on NEW frames)
Every 120 s: TranStar RSS (incidents, lane closures, travel times)
Storage    : spikes/data/log.db (SQLite) + spikes/data/frames/<cam>/ for the 20 cams nearest Ion

Run (leave it running all weekend, Ctrl+C to stop):
    spikes/.venv/Scripts/python spikes/logger.py
Quick test:
    spikes/.venv/Scripts/python spikes/logger.py --minutes 3
Report:
    spikes/.venv/Scripts/python spikes/log_report.py
"""
import argparse, hashlib, io, json, re, sqlite3, time, urllib.request, xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image

HERE = Path(__file__).parent
DATA = HERE / "data"
ION = (29.7336, -95.3790)
UA = {"User-Agent": "Mozilla/5.0 (Houston hackathon data logger)"}
N_NEAR_ION, N_SAVE_FRAMES, CROSSING_CAM_M = 40, 20, 200
TW_URL = ("https://services.arcgis.com/NummVBqZSIJKUeVR/arcgis/rest/services/Train_Watch_Layer/FeatureServer/0/query"
          "?where=1%3D1&outFields=code,street,crossingStatus,sensorStatus,timeToClear,timeUpdated,predictedStart,"
          "trainTravelDirection,trainMovement&outSR=4326&f=json")
RSS = {k: f"https://traffic.houstontranstar.org/data/rss/{k}_rss.xml" for k in ("incidents", "laneclosures", "traveltimes")}

SCHEMA = """
create table if not exists crossings(ts text, code text, street text, status text, sensor text,
  time_to_clear text, time_updated text, predicted_start text, direction text, movement text);
create table if not exists frames(ts text, cam text, name text, md5 text, changed int, valid int,
  reason text, cars int, secs_since_change real);
create table if not exists rss(ts text, feed text, title text, descr text);
create table if not exists errors(ts text, source text, msg text);
"""


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20) as r:
        return r.headers.get("Content-Type", ""), r.read()


def meters(a, b):
    import math
    la1, lo1, la2, lo2 = map(math.radians, (*a, *b))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 6371000 * 2 * math.asin(math.sqrt(h))


def pick_cameras(crossings):
    _, js = fetch("https://traffic.houstontranstar.org/data/layers/cctvSnapshots_out.js")
    pat = re.compile(r"new CctvCamera\('([^']*)','[^']*','[^']*','[^']*','([-\d.]+)','([-\d.]+)','[^']*','([^']*)'")
    cams = [{"name": n, "lat": float(a), "lng": float(b), "path": p} for n, a, b, p in pat.findall(js.decode("utf-8", "ignore"))]
    near = sorted(cams, key=lambda c: meters(ION, (c["lat"], c["lng"])))[:N_NEAR_ION]
    save = {c["path"] for c in near[:N_SAVE_FRAMES]}
    by_cross = [c for c in cams if any(meters((x["lat"], x["lng"]), (c["lat"], c["lng"])) <= CROSSING_CAM_M for x in crossings)]
    chosen = {c["path"]: c for c in near + by_cross}
    return list(chosen.values()), save


def validate(ctype, body):
    if "image" not in ctype:
        return False, f"not an image ({ctype or 'no type'})"
    if len(body) < 3000:
        return False, "too small"
    try:
        Image.open(io.BytesIO(body)).verify()
    except Exception:
        return False, "corrupt jpeg"
    return True, ""


class Logger:
    def __init__(self):
        DATA.mkdir(exist_ok=True)
        self.db = sqlite3.connect(DATA / "log.db")
        self.db.executescript(SCHEMA)
        self.last_md5, self.last_change = {}, {}
        self.model = None

    def err(self, src, e):
        self.db.execute("insert into errors values(?,?,?)", (now(), src, f"{type(e).__name__}: {e}"))
        print(f"  ! {src}: {type(e).__name__}: {e}")

    def yolo(self, body):
        if self.model is None:
            from ultralytics import YOLO
            self.model = YOLO(str(HERE / "yolov8s.pt") if (HERE / "yolov8s.pt").exists() else "yolov8s.pt")
        img = Image.open(io.BytesIO(body)).convert("RGB")
        return len(self.model(img, classes=[2, 3, 5, 7], conf=0.2, imgsz=1280, verbose=False)[0].boxes)

    def log_crossings(self):
        ts = now()
        feats = json.loads(fetch(TW_URL)[1])["features"]
        self.db.executemany("insert into crossings values(?,?,?,?,?,?,?,?,?,?)", [
            (ts, a["code"], a["street"], a["crossingStatus"], a["sensorStatus"], a["timeToClear"], a["timeUpdated"],
             str(a["predictedStart"]), a["trainTravelDirection"], a["trainMovement"])
            for a in (f["attributes"] for f in feats)])
        return feats

    def log_cameras(self, cams, save):
        new = 0
        for c in cams:
            ts, key = now(), c["path"]
            try:
                ctype, body = fetch(f"https://www.houstontranstar.org/snapshots/cctv/{key}")
            except Exception as e:
                self.err(f"cam {key}", e)
                continue
            ok, reason = validate(ctype, body)
            md5 = hashlib.md5(body).hexdigest()
            changed = md5 != self.last_md5.get(key)
            t = time.time()
            since = t - self.last_change[key] if key in self.last_change else None
            if changed:
                self.last_md5[key], self.last_change[key] = md5, t
            cars = None
            if ok and changed:
                new += 1
                try:
                    cars = self.yolo(body)
                except Exception as e:
                    self.err(f"yolo {key}", e)
                if key in save:
                    d = DATA / "frames" / key.replace(".jpg", "")
                    d.mkdir(parents=True, exist_ok=True)
                    (d / f"{ts.replace(':', '')}.jpg").write_bytes(body)
            self.db.execute("insert into frames values(?,?,?,?,?,?,?,?,?)",
                            (ts, key, c["name"], md5, int(changed), int(ok), reason, cars, since))
        return new

    def log_rss(self):
        ts, n = now(), 0
        for feed, url in RSS.items():
            try:
                root = ET.fromstring(fetch(url)[1])
                items = [(ts, feed, i.findtext("title"), i.findtext("description")) for i in root.iter("item")]
                self.db.executemany("insert into rss values(?,?,?,?)", items)
                n += len(items)
            except Exception as e:
                self.err(f"rss {feed}", e)
        return n

    def run(self, minutes=None):
        feats = self.log_crossings()
        cams, save = pick_cameras([{"lat": f["geometry"]["y"], "lng": f["geometry"]["x"]} for f in feats])
        print(f"Logging {len(cams)} cameras ({len(save)} with saved frames), 56 crossings, 3 RSS feeds -> {DATA / 'log.db'}")
        start, tick = time.time(), 0
        while minutes is None or time.time() - start < minutes * 60:
            t0 = time.time()
            try:
                if tick:
                    self.log_crossings()
            except Exception as e:
                self.err("trainwatch", e)
            new = self.log_cameras(cams, save)
            rss = self.log_rss() if tick % 2 == 0 else 0
            self.db.commit()
            print(f"{datetime.now():%H:%M:%S} tick {tick}: {new} new camera frames, rss items {rss}, took {time.time() - t0:.0f}s")
            tick += 1
            time.sleep(max(0, 60 - (time.time() - t0)))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--minutes", type=float, help="stop after N minutes (default: run forever)")
    try:
        Logger().run(ap.parse_args().minutes)
    except KeyboardInterrupt:
        print("stopped")
