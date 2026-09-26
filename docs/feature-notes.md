# Houston Hackathon 2026 — Feature Notes / 功能笔记

Last updated / 更新: 2026-09-25
Status / 状态: Brainstorming — not final / 头脑风暴中，未定稿

## Data check results (tested 2026-09-25) / 数据检查结果

| Data / 数据 | Status / 状态 | Notes / 说明 |
|---|---|---|
| Train Watch crossings / 道口 | ✅ Works / 可用 | Public ArcGIS layer, no key. 56 crossings. Fields include `crossingStatus`, `timeToClear`, `predictedStart`, `sensorStatus`. URL: `https://services.arcgis.com/NummVBqZSIJKUeVR/arcgis/rest/services/Train_Watch_Layer/FeatureServer/0/query?where=1%3D1&outFields=*&f=json` |
| TranStar cameras / 摄像头 | ✅ Works / 可用 | 1,388 cameras listed at `https://traffic.houstontranstar.org/data/layers/cctvSnapshots_out.js`. Snapshot: `https://www.houstontranstar.org/snapshots/cctv/<path>` (e.g. `1002.jpg`). Usage terms NOT yet verified — ask at kickoff. / 使用条款未核实 |
| TranStar speeds / incidents / flood | ⚠️ Samples only / 仅样例 | Samples at `https://traffic.houstontranstar.org/api/<name>_sample.json`. Live feeds = 403, request access. / 实时接口需申请 |
| TxDOT CRIS crashes / 事故 | ⚠️ Manual CSV / 手动导出 | Browser query + CSV export; bulk needs registration. |
| DriveTexas construction / 施工 | ⚠️ Needs key / 需 key | 401 without key. |
| Google Routes API | Not tested / 未测试 | Needs Google Cloud key. |

## Our features / 我们的功能

### Tier 1 — data confirmed / 数据已确认
1. **Live crossing map / 实时道口地图** — Train Watch 56 crossings, blocked = red. / 56 个道口实时状态
2. **"Blocked on my route" alert / 路线道口提醒** — warn if a crossing on the route is blocked, show `timeToClear` when available. / 路线上道口被堵时提醒，并显示预计通行时间
3. **Camera AI check / 摄像头 AI 识别** — grab snapshots along the route, AI flags crash / stalled car / flooding / train / heavy congestion. / AI 识别车祸、抛锚、积水、火车、拥堵
4. **Route camera strip / 路线摄像头预览** — see the live snapshots of your route before leaving. / 出发前看一眼沿途实时画面
5. **Our own history log / 自建历史数据** — log Train Watch + camera results every few minutes all weekend; show patterns in the demo. / 周末持续记录，演示时展示规律

### Tier 2 — needs sign-up / 需要注册
6. **Multi-stop planner / 多站点规划** — 3 stops, best order + best departure time (Google Routes API). / 最佳顺序和出发时间
7. **Safe-route score / 安全路线评分** — crash history from CRIS CSV, faster ↔ safer slider. / 历史事故评分，快慢与安全可调
8. **Dynamic scheduling / 动态调度** — (user request 2026-09-25) keep re-checking the day's plan; when a crossing blocks or a camera flags a crash, re-plan the remaining stops and shift departure times. / 路况变化时自动重排剩余站点和出发时间
   - Decided 2026-09-25: **A + C** = auto re-plan every few minutes + push alert, AND each stop can have a flexible time window (e.g. arrive B between 2–4 PM); planner picks the best time inside the window. / 自动重排 + 推送，加上每站可设弹性时间窗

### Tier 3 — needs access request / 需要申请
9. **Live freeway speeds, incidents, flood alerts / 高速实时车速、事故、积水** — TranStar live feeds.

## Team-suggested features / 队友补充功能
_Teammates are adding more ideas. Add them below with name + data source needed._
_队友正在补充想法，请在下面填写：功能、提出人、需要的数据源。_

Team: 5 people. Added 2026-09-25 from team notes (Jessie + group).

| Feature / 功能 | Proposed by / 提出人 | Data needed / 需要的数据 | Tier | Notes / 备注 |
|---|---|---|---|---|
| Crash prediction on busy roads / 高频道路事故预测 | Team | US Accidents (Kaggle) or CRIS | 2 | Realistic scope = crash **risk score** per road × time slot, not predicting individual crashes / 做成风险分 |
| Start time as push notification / 出发时间推送 | Team | TomTom + history | 2 | = our dynamic scheduling alert / 已有 |
| Dynamic scheduling / 动态调度 | Team | TomTom + Train Watch + cameras | 2 | = feature #8 (A + C) / 已有 |
| Routing around predicted train paths / 根据火车预测路径规划路线 | Team | Train Watch `predictedStart`, `trainTravelDirection`, `trainMovement` | 1 | Fields exist but were null in our 2026-09-25 test → need to log over the weekend to see if they fill in / 字段存在但测试时为空 |
| Safe path avoiding crash-prone highways / 避开事故多发高速 | Team | crash data | 2 | = feature #7 / 已有 |
| View Houston highway cameras / 查看高速摄像头 | Team | TranStar cameras | 1 | = feature #4, 1,386 cameras / 已有 |
| View train cameras / 查看道口摄像头 | Team | TranStar cameras near Train Watch crossings | 1 | No dedicated train cameras found; match cameras within ~0.3 mi of crossings — coverage not checked yet / 未找到专门的道口摄像头 |
| Congestion score per road per time slot / 每路段每时段拥堵分 | Team | TranStar history (seed) + YOLO counts + TomTom (daily) | 1 | Store per road × weekday × 15-min slot. Seed from TranStar historical. Update = moving average: `new = old + α × (today − old)`, α ≈ 0.1–0.2. Don't add `today × α` onto old — score would grow forever. / 用移动平均更新 |
| Exploit blind spots / 利用覆盖盲区 | Jessie | — | — | Blind spots: Train Watch = 56 of 700+ crossings; Bluetooth/AVI readers = freeways only; TranStar history = weekdays only → our cameras + TomTom + logs fill these / 盲区即卖点 |

## Reference GitHub projects / 参考项目
- **anorum/trainspotter** (Portland) — closest match. Polls 6 public cameras every 15–30 s, detects train blocking via image differencing vs. empty-crossing median / Claude Haiku (~$0.0003/frame) / MobileNetV3. "UNKNOWN" is a valid answer. Builds its own history because DOT doesn't archive frames. Clear-time prediction NOT built yet → our gap to fill.
- **khordoo/traffic-watch-object-detection** (Calgary) — city cameras every 5 min → YOLO counts cars/people → LSTM 24h forecast + anomaly detection → Mapbox map. Borrow the pipeline shape.
- **pganssle/traffic-wallpaper** (Houston) — small inactive Python script pulling TranStar cameras every 30 s. Proves scraping works; not much to reuse.
- **Dorianbansoodeb/smartcity-vision** — YOLOv8n + ByteTrack, FastAPI, SQLite, privacy redaction. Detection module + privacy layer reusable on stills; tracking/speed need video.

User likes #1 trainspotter and #2 traffic-watch most (2026-09-25).

## Waze check / Waze 调研 (2026-09-25)
- Overlap: crowd hazard/crash reports, Planned Drives (best time to leave, single destination), static railroad-crossing warnings.
- Gaps we fill: no live "train is blocking now" status, multi-stop limited to 1 extra stop and not in Planned Drives, no camera verification, no crash-history safe routing.
- Data: NO public API. Waze for Cities feed is only for government agencies / road operators, no commercial use. Don't scrape (ToS). → Ask city officials whether Houston is a partner.
- Waze iFrame (`https://embed.waze.com/iframe?zoom=14&lat=29.7336&lon=-95.3790&pin=1`): official, embeddable (tested 2026-09-25, no framing block). **Display only** — no JS/postMessage API, cross-origin so we can't read its data or draw our layers on it. Terms: don't mix Waze branding with non-Waze maps. → Use as a separate "live traffic" panel next to our own map.
- Usable for free: Waze deep links (`https://waze.com/ul?ll=<lat>,<lng>&navigate=yes`) — our app plans, Waze/Google Maps navigates.

## Decisions / 已定
- Platform: phone-friendly (responsive) website; PWA add-on for home screen + push. / 手机可访问的网站
- Camera AI: **YOLO car counting** (congestion level per camera) + **Train Watch** for trains (2026-09-25). / YOLO 数车判断拥堵，火车用 Train Watch
  - Known gap: YOLO won't detect flooding or crashes from cameras; crossings outside Train Watch's 56 aren't covered. Revisit only if time allows. / 已知缺口：摄像头不识别积水、车祸

## Routing API budget / 路线 API 用量估算 (2026-09-25)
Free tiers (checked 2026-09-25): Google Routes — Essentials 10,000 / Pro 5,000 / Enterprise 1,000 per month (traffic-aware likely Pro; card required). TomTom — Routing 20,000/month, Matrix 2,500/month, Traffic Flow 2,500/month, no card.
Estimate for one 3-stop plan: 4 places → 12 legs × 8 departure slots (every 15 min, 2 h) = ~96 calls. Dynamic re-plan every 5 min for 4 h = ~48 × ~6 = ~300 calls.
Weekend total with caching ≈ 3,000–4,000 calls (dev ~2,000, one full-day dynamic test ~400, 5 rehearsals ~500, live demo ~100).
→ Fits TomTom Routing (20K) easily; fits Google Pro (5K) but tight. Cache per (origin, dest, 15-min slot); use saved responses during UI dev.

## Historical data already out there / 现成的历史数据 (2026-09-25)
| Data | Access | Use |
|---|---|---|
| **TranStar Historical Freeway Travel Times** `https://traffic.houstontranstar.org/hist/traveltimes_web.aspx?id=<1..50>&year=<2011..2025>` | ✅ tested, public HTML table | avg travel time + speed per 15-min departure slot, 5 AM–7 PM weekdays, 50 freeway routes, 2011–2025 → "best time to leave" with 0 API calls |
| TranStar Speed Map Archive `https://traffic.houstontranstar.org/map_archive/` | ✅ page loads (200) | maps every 15 min, 24/7 — visual, not tested as data |
| US Accidents (Kaggle, Moosavi) | free Kaggle login (user downloads) | 7.7M US crashes 2016–2023, ~169,609 in Houston, severity 1–4 → crash hotspots without CRIS |
| FRA Blocked Crossing reports `https://www.fra.dot.gov/blockedcrossings/incidents` | ✅ page loads (200), export not tested | public reports of blocked crossings → which Houston crossings block most, time of day |
| FRA grade-crossing incidents (Form 57) `data.transportation.gov` icqf-xf4w | ✅ API reachable | train–vehicle collisions at crossings → crossing risk |
| NPMRDS (5-min speeds, all NHS roads) | ❌ agencies / contractors only | skip |
Plan: historical data = baseline prediction; live API calls only to adjust for today → far fewer requests. (Approved 2026-09-25)

Substitutes for TranStar history (streets + weekends):
- Routing APIs with a future departure time (TomTom `departAt`, Mapbox `depart_at`, Google) — their predictions are built from historical traffic, so a future-time query = "typical traffic" for that slot.
- Our own log: poll TomTom Traffic Flow on a few key streets all weekend (watch the 2,500/month cap).
- City of Houston GeoHub "Traffic Counts – Speed" / ADT — street-level counts, volumes not travel times.
- Paid only (skip): TomTom Traffic Stats, HERE historical. Uber Movement shut down.

## Decisions / 已定 (routing)
- Routing API: **TomTom as main** (2026-09-25).
- Backups (free tiers from third-party pricing summaries, not verified on vendor pages): Mapbox Directions ~100,000/month, `driving-traffic` profile; HERE Routing v8 ~30,000/month (freemium, no card to start); Azure Maps ~1,000 route calls/month (too small).

## Spike: must-have test (`spikes/must_have_test.py`, throwaway) — 2026-09-25 4:21 PM
All 5 PASS: crossing map, YOLO counts (20 cams in ~9–24 s on CPU), 3-stop planner w/ windows, re-plan on block, replay.
Findings:
- vs proxy baseline (typed order, leave now, same traffic model): reorder saved **6 min** in normal conditions; with a 60-min train block on the route, re-plan saved **54 min**. Value is in disruption days, not normal days.
- ~~Stale data~~ **CORRECTED 4:26 PM**: DOWN-sensor crossings DO update — Commerce St went blocked → clear, Lockwood + Leeland went clear → blocked, `timeUpdated` (UTC) fresh within 2 min. The ~1 h Commerce block was probably a real parked train. What `sensorStatus: DOWN` means is unclear → ask the city; for now show DOWN crossings as "low confidence", and use `timeUpdated` age to detect truly stale data.
- Freeway routes rarely touch Train Watch crossings (all on surface streets); crossing features matter for East End / industrial trips.
- YOLO undercounts small/distant cars on 320×240 frames (e.g. 18 counted where ~30+ visible) → use per-camera relative baseline, not absolute counts.
- Real Google/Apple comparison still not done — needs logged real drives.

## Substitutes found (2026-09-25 4:26 PM) / 替代方案
- **Camera refresh rate** (measured 2026-09-25 ~4:45 PM, 4 min, 15 s polls, `spikes/refresh_probe.py`): freeway cams 504 → new image after ~127 s; 1002 → gaps 64 s and 156 s; street cam 8048 (Hempstead@Antoine) → no change in 4 min. ⇒ freeway ≈ every 1–2.5 min, street cams slower (> 4 min) or frozen. Still images only; no public live video (TranStar, TxDOT ITS both snapshot-only).
- **TranStar RSS = live data, public, no key** (tested, pubDate 2 min old):
  - `https://traffic.houstontranstar.org/data/rss/incidents_rss.xml` — 21 live incidents (location, type, lanes, verified time)
  - `.../data/rss/laneclosures_rss.xml` — 118 closures
  - `.../data/rss/traveltimes_rss.xml` — 140 freeway segments, live travel time (this is the Bluetooth/AVI data)
  - per-freeway: `.../data/rss/traffic_rss_<ih-10_east|ih-10_katy|ih-45_gulf|ih-45_north|ih-69_eastex|ih-69_southwest|sh-225|sh-249|sh-288|us-290_northwest>.xml`
  → replaces the 403 JSON feeds for incidents / closures / travel times. Flood feed still missing (try Harris County FWS, site reachable).
- **YOLO undercount** → `yolov8s.pt` at `imgsz=1280`: 28 vs 20 cars on the same frame (~30–35 visible), 0.67 s/img on CPU. Use it.
- **Train Watch reliability** → cross-check with TomTom Traffic Flow speed on the crossing's street + nearby camera + FRA history.
- Flooding: postponed by user (2026-09-25), add later.

## If Train Watch fails — substitutes / Train Watch 的替代品 (2026-09-25)
Train Watch = ~70 donated acoustic sensors (+ cameras to validate), vendor not public.
Commercial (need a city contract — pitch as "future partner", not usable this weekend):
- **TRAINFO** — acoustic sensors + ML, predicts blockage start/end up to ~10 min ahead; ran FRA-funded research in Houston 2018–2023.
- **RailState** — camera sensors near crossings, measures blocked-crossing risk/duration; sells to agencies.
DIY (usable now):
1. TranStar cameras near crossings — tested: 14 of 56 Train Watch crossings have a camera within 200 m (27 within 800 m).
   **Visual check 2026-09-25 4:31 PM (`spikes/crossing_cams/_sheet.jpg`): 0 of 14 clearly show the tracks.** 2 maybe (Hempstead@Blalock far background; I-610@Almeda shows a rail *bridge*, grade-separated). Rest point at the intersection. → "Train cameras" feature does not work as-is; reframe as "car queue near crossing" (YOLO count spike = likely blocked).
   Camera problems found: 1 returns an HTML page instead of JPG (Gessner), 1 shows "Camera error" (Broadway), 1 frozen image from **07/14/2021** (Cullen@Leeland), 1 shows "© 2020" (Kingwood, likely frozen). → must validate every snapshot: content-type, error frame, stale (image unchanged across polls / old timestamp).
2. TomTom Traffic Flow speed on the crossing's street — speed ≈ 0 near tracks = likely blocked (indirect).
3. FRA blocked-crossing reports — history → "likely blocked at this time" probability.
4. In-app crowd report button "train blocking here" — the feature Waze users keep requesting.
5. FRA crossing inventory — locations of all 700+ crossings (no status) so routes can at least flag them.

## Data logger / 数据记录程序 (`spikes/logger.py` + `spikes/log_report.py`, throwaway)
4-min test 2026-09-25 4:54 PM: 53 cameras, 56 crossings, 3 RSS feeds, 0 errors, ~1.2 MB (≈18 MB/h → ~1 GB for the weekend).
- Camera refresh: 32 cams refreshed, median **~114 s (~2 min)**, range 49–133 s. 21 cams never changed in 4 min (mostly street cams 80xx + a few freeway) → need a longer run to tell slow vs frozen.
- Hempstead@Gessner returns HTML every time → excluded automatically.
- YOLOv8s counts up to 38 vehicles (45 Gulf @ Scott).
- Crossing sessions already captured: York St blocked 1 min, Lockwood St blocked (open).

## Crash hotspots / 事故热点 (2026-09-25, `spikes/crash_hotspots.py`)
Source: **City of Houston Vision Zero High Injury Network 2025**, public ArcGIS, no key:
`https://services.arcgis.com/NummVBqZSIJKUeVR/arcgis/rest/services/HIN2025_All_WK/FeatureServer/3` (layers 0 priority segments, 1 bike, 2 ped, 3 all).
1,080 segments (~0.5 mi each), 4,620 crashes, 762 deaths. Fields: `Full_Name`, `Total_Crash_Count`, `Total_Death_Count`, `Veh/Ped/Bike_Crash_Count`, `CrashRate` (per mile).
Likely severe (fatal + serious-injury) crashes only — confirm methodology before pitching numbers.
- Worst segments: Westheimer Rd @ 29.7377,-95.4973 (21 crashes, 6 deaths); **Fannin St @ 29.7490,-95.3700 (19, 6) — ~1 mi from Ion**; Federal Rd; Hillcroft Ave; **Pierce St @ 29.7484,-95.3691 (13) — near Ion**.
- Worst whole roads: Westheimer (237 crashes / 61 deaths / 13 mi), Fondren, Bissonnet, Richmond, Bellaire.
- Plan: snap route geometry to segments within ~30 m → add `crash risk` to route cost, show a warning on the map.
- For intersection-level + time-of-day detail: US Accidents (Kaggle) or CRIS, later.

## Team repo review / 团队仓库审阅 (github.com/atatti-240/houston-traffic-app @ dbe17e4, 2026-09-25)
Built from build prompts 1–9 (`docs/build-prompts.md`). **Done: prompts 1–4** — ARCHITECTURE.md, FastAPI skeleton (`/health` only), SQLAlchemy models, hand-made 24-node Houston graph, 8-week synthetic history, mock adapters, 3 EMA models (congestion / crash / train, formula already fixed), tests. Frontend = Next.js 16 + react-leaflet, blank map only.
**Not done: prompts 5–9** — routing (`routing/` empty), recommender, notifications, REST API (`api/` empty), frontend UI, demo mode.
Differences vs our research: all data synthetic (cameras = `cameras.example` URLs, crossings approximate); single origin→destination + arrive_by (no multi-stop / time windows); computer vision explicitly out; own graph + Dijkstra instead of TomTom/OSRM; stack = Next.js/TypeScript + uv (not plain JS).
Fits well: adapter interfaces `SpeedSource / CrashSource / TrainSource / CameraSource` map 1:1 to our tested real feeds; sim clock = our replay mode; EMA = our congestion score.
Sample API contracts: `docs/contracts/{trip_request,plan_result,live_conditions}.json`.

## Officials' answers / 官员答复 (reported by user 2026-09-25)
1. TranStar cameras + RSS for the hackathon: **allowed** / 可以使用
2. Train Watch `sensorStatus: DOWN` meaning: **unknown** → keep "low confidence" label + cross-check / 不知道
3. TranStar live JSON access / Waze for Cities: **no** → stay on RSS + TomTom; flooding needs another source / 不行

## Open questions / 待决定
- Q6 (deferred 2026-09-25): team languages + roles — user still drafting the outline in plan.md.
- ~~Q1: Demo centerpiece?~~ → **C: both equally** (decided 2026-09-25) / 两者并重
- Spike `spikes/ion_traffic_test.py` (throwaway) ran 2026-09-25 ~3:30 PM: Train Watch 3 crossings within 3 mi of Ion (Commerce St blocked, clears in 6 min); 56 cameras within 3 mi, snapshots download; TranStar live JSON feeds all 403, samples 200.
- Ask at kickoff: TranStar camera usage + live feed access. / 开幕式上问：摄像头使用许可和实时数据权限
