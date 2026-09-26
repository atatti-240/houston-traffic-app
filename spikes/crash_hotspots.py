"""THROWAWAY SPIKE: rank Houston's worst road segments from the city's official
Vision Zero High Injury Network 2025 (public ArcGIS layer, no key)."""
import json, urllib.request
URL = ("https://services.arcgis.com/NummVBqZSIJKUeVR/arcgis/rest/services/HIN2025_All_WK/FeatureServer/3/query"
       "?where=1%3D1&outFields=Full_Name,Total_Crash_Count,Total_Death_Count,Veh_Crash_Count,Ped_Crash_Count,"
       "Bike_Crash_Count,Miles,CrashRate&outSR=4326&returnGeometry=true&f=json&resultRecordCount=2000")
feats = json.load(urllib.request.urlopen(URL, timeout=60))["features"]
rows = []
for f in feats:
    a, path = f["attributes"], f["geometry"]["paths"][0]
    mid = path[len(path) // 2]
    rows.append({**a, "lat": round(mid[1], 5), "lng": round(mid[0], 5)})
json.dump(rows, open("hin2025_segments.json", "w"))
print(f"{len(rows)} segments, {sum(r['Total_Crash_Count'] for r in rows)} crashes, {sum(r['Total_Death_Count'] for r in rows)} deaths\n")
for key, label in (("Total_Crash_Count", "most crashes"), ("CrashRate", "highest crash rate (per mile)"), ("Total_Death_Count", "most deaths")):
    print(f"Top 10 by {label}:")
    for r in sorted(rows, key=lambda r: -r[key])[:10]:
        print(f"  {r['Full_Name']:<24} crashes={r['Total_Crash_Count']:>3} deaths={r['Total_Death_Count']:>2} "
              f"rate={r['CrashRate']:>6} miles={r['Miles']:<5} @ {r['lat']},{r['lng']}")
    print()
by_road = {}
for r in rows:
    d = by_road.setdefault(r["Full_Name"], [0, 0, 0.0])
    d[0] += r["Total_Crash_Count"]; d[1] += r["Total_Death_Count"]; d[2] += r["Miles"]
print("Top 10 whole roads (all segments summed):")
for name, (c, dth, mi) in sorted(by_road.items(), key=lambda x: -x[1][0])[:10]:
    print(f"  {name:<24} crashes={c:>4} deaths={dth:>3} miles={mi:.1f}")
