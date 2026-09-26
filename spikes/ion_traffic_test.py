"""THROWAWAY SPIKE — tests which Houston traffic data we can reach near Ion District.
Not product code. Standard library only.

Run: python spikes/ion_traffic_test.py
"""
import json, math, re, urllib.request, urllib.error, pathlib

ION = (29.7336, -95.3790)  # Ion District, 4201 Main St
RADIUS_MI = 3
UA = {"User-Agent": "Mozilla/5.0 (hackathon data test)"}
OUT = pathlib.Path(__file__).parent / "snapshots"


def get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.status, r.read()


def miles(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 3958.8 * 2 * math.asin(math.sqrt(h))


def train_watch():
    print(f"\n=== 1. Train Watch crossings within {RADIUS_MI} mi ===")
    url = (
        "https://services.arcgis.com/NummVBqZSIJKUeVR/arcgis/rest/services/Train_Watch_Layer/FeatureServer/0/query"
        f"?where=1%3D1&outFields=street,code,crossingStatus,sensorStatus,timeToClear,timeUpdated"
        f"&geometry={ION[1]},{ION[0]}&geometryType=esriGeometryPoint&inSR=4326&outSR=4326"
        f"&distance={RADIUS_MI}&units=esriSRUnit_StatuteMile&f=json"
    )
    _, body = get(url)
    feats = json.loads(body).get("features", [])
    rows = []
    for f in feats:
        a, g = f["attributes"], f["geometry"]
        rows.append((miles(ION, (g["y"], g["x"])), a))
    for d, a in sorted(rows, key=lambda r: r[0]):
        print(f"  {d:4.1f} mi  {a['street']:<28} status={a['crossingStatus']:<8} sensor={a['sensorStatus']}  clear_in={a['timeToClear']}")
    print(f"  -> {len(rows)} crossings found")


def cameras():
    print(f"\n=== 2. TranStar cameras within {RADIUS_MI} mi ===")
    _, body = get("https://traffic.houstontranstar.org/data/layers/cctvSnapshots_out.js")
    pat = re.compile(r"new CctvCamera\('([^']*)','[^']*','([^']*)','[^']*','([-\d.]+)','([-\d.]+)','[^']*','([^']*)'")
    cams = [(miles(ION, (float(la), float(lo))), name, road, path) for name, road, la, lo, path in pat.findall(body.decode("utf-8", "ignore"))]
    near = sorted(c for c in cams if c[0] <= RADIUS_MI)
    print(f"  {len(cams)} cameras total, {len(near)} nearby")
    OUT.mkdir(exist_ok=True)
    for d, name, road, path in near[:5]:
        url = f"https://www.houstontranstar.org/snapshots/cctv/{path}"
        try:
            _, img = get(url)
            (OUT / path).write_bytes(img)
            print(f"  {d:4.1f} mi  {name:<40} saved snapshots/{path} ({len(img)//1024} KB)")
        except urllib.error.HTTPError as e:
            print(f"  {d:4.1f} mi  {name:<40} HTTP {e.code}")


def transtar_feeds():
    print("\n=== 3. TranStar JSON feeds (live vs sample) ===")
    for name in ("incidents", "laneclosures", "speedsegments", "roadwayfloodwarning"):
        for kind, url in (("live", f"https://traffic.houstontranstar.org/api/{name}.json"),
                          ("sample", f"https://traffic.houstontranstar.org/api/{name}_sample.json")):
            try:
                code, body = get(url)
                ts = json.loads(body).get("callTimestamp", "?")
                print(f"  {name:<20} {kind:<6} HTTP {code}  data timestamp: {ts}")
            except urllib.error.HTTPError as e:
                print(f"  {name:<20} {kind:<6} HTTP {e.code}  (blocked)")


if __name__ == "__main__":
    print(f"Ion District @ {ION}")
    for step in (train_watch, cameras, transtar_feeds):
        try:
            step()
        except Exception as e:
            print(f"  FAILED: {type(e).__name__}: {e}")
