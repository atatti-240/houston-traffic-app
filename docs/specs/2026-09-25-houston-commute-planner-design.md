# Houston Commute Planner — Design Spec / 设计文档

Date / 日期: 2026-09-25 · Event / 活动: Houston Hackathon 2026 (Ion District) · Deadline / 截止: Sun 2026-09-27 11:45 PM
Status / 状态: **Draft — awaiting team review / 草稿，等待团队审阅**
Related / 相关: [outline.md](../outline.md) · [feature-notes.md](../feature-notes.md) (all test evidence / 全部测试证据)

---

## 1. Purpose & success criteria / 目标与成功标准
> 中文摘要：帮休斯顿司机在一天多个站点的行程里，决定先去哪、几点出发，并在火车堵道或事故时自动重新规划。

**Who / 用户:** Houston drivers with 2–3 stops in a day (students, shift workers, errands).
**Problem / 问题:** Google / Apple / Waze don't know when a freight train is blocking a crossing, don't optimize multi-stop order with time windows, and ignore Houston-specific data (TranStar, Train Watch, Vision Zero).
**Success at demo / Demo 成功标准:**
1. User enters 3 stops with time windows on a phone → gets stop order + "leave by" times in < 5 s.
2. A train blockage (live or replayed) on the route triggers a re-plan and a push alert with the reason.
3. Map shows crossings, camera congestion, and high-injury segments on the chosen route.
4. Pitch shows measured value: normal day ≈ −6 min; disruption day (60-min block) ≈ −54 min (spike result).

## 2. Scope / 范围
> 中文摘要：5 个必做项必须完成；加分项只在必做全部跑通后才做。

**Must-have / 必做**
| # | Feature | Spike status |
|---|---|---|
| M1 | Crossing map (Train Watch, 56 crossings) | ✅ passed |
| M2 | Camera congestion (YOLOv8s counts vs per-camera baseline) | ✅ passed |
| M3 | Multi-stop planner (≤ 3 stops, time windows) | ✅ passed |
| M4 | Dynamic re-plan every 5 min + push alert | ✅ passed (simulated) |
| M5 | Demo replay mode (replay logged data) | ✅ passed |

**Bonus / 加分 (in priority order)** — B1 crash-risk cost + map warnings (Vision Zero HIN 2025) · B2 Waze live iFrame panel + "Go" deep link · B3 congestion score (moving average) · B4 "train blocking here" user report · B5 queue detection near crossings · B6 city report export · B7 EN/ES toggle.

**Out of scope / 不做:** flooding (later), native apps, our own navigation, live video (not publicly available), user accounts.

## 3. Architecture / 架构
> 中文摘要：后台 5 个模块（采集、数据库、历史导入、规划器、推送），前端一个手机网站。每个模块职责单一、接口清楚。

**Builds on the team repo** [atatti-240/houston-traffic-app](https://github.com/atatti-240/houston-traffic-app) (commit `dbe17e4`, prompts 1–4 done). Its `ARCHITECTURE.md` stays the base; this spec adds real data, multi-stop and YOLO. / 以团队仓库为基础，在其上增加真实数据、多站点和 YOLO。

```
adapters/ (real: TrainWatch, TranStar RSS+history, VisionZero, TranStar cameras+YOLO; mock kept)
     │
scoring/ (EMA congestion · crash risk · train block)  ◄── ScoreStore (SQLite)
     │
routing/ (time-dependent Dijkstra on the small graph) ──► recommender.py ──► multistop.py
                                                                    │
                                              notifications/ (scheduler + web push)
                                                                    │
                                      api/ (FastAPI) ──► frontend/ (Next.js PWA + Leaflet)
clock.py (simulated clock) drives replay of logged real data
```

| Unit / 模块 | Status in repo | Does / 职责 | Interface / 接口 |
|---|---|---|---|
| `adapters/base.py` | ✅ exists | `SpeedSource`, `CrashSource`, `TrainSource`, `CameraSource` | unchanged |
| `adapters/real/trainwatch.py` | 🆕 add | Train Watch → `TrainSource` (`crossing_events`, `active_blockages`); confidence from `sensorStatus` | `TrainSource` |
| `adapters/real/transtar_speed.py` | 🆕 add | TranStar historical (per 15-min slot) + RSS live travel times → `SpeedSource`, mapped to graph segments by corridor | `SpeedSource` |
| `adapters/real/visionzero.py` | 🆕 add | HIN 2025 → crash-risk **prior** per graph segment (aggregate counts, not dated records) | `CrashSource` + seed prior |
| `adapters/real/cameras.py` | 🆕 add | Real TranStar camera list + snapshot validation + YOLOv8s count vs per-camera baseline → live congestion override | `CameraSource` + `congestion_now(segment)` |
| `seed/network.py` | ✅ exists → edit | Add places: UH Sugar Land, UH main, Ion District (+ SW freeway links); replace approximate crossings with real Train Watch coords; replace `cameras.example` URLs | — |
| `scoring/` | ✅ exists | 3 EMA models; seed from real history instead of synthetic when available | unchanged |
| `routing/` | ❌ prompt 5 | Time-dependent Dijkstra, Safe Path, best + alternative, "why" | `route(origin, destination, depart_at, safe_path)` |
| `recommender.py` | ❌ prompt 6 | Latest departure that arrives on time | `recommend_departure(origin, destination, arrive_by, safe_path, buffer_min)` |
| `multistop.py` | 🆕 add | Try all stop orders (≤ 3 → 6) × departures; time windows; re-plan | `plan(start, stops, depart_after, safe_path) -> Plan` (see `docs/contracts/`) |
| `notifications/` | ❌ prompt 6 | Scheduler re-checks saved plans each tick; mock + web push | as in `ARCHITECTURE.md` |
| `api/` | ❌ prompt 7 | Repo's endpoints + `POST /plan`, `GET /plan/{id}`, `GET /live` | JSON per `docs/contracts/*.json` |
| `frontend/` | 🟡 blank map | Trip input (multi-stop), plan + map, live view (cameras, crossings, Waze iFrame), alerts | calls `api/` |
| `clock.py` | ✅ exists | Simulated time → replay of weekend logs | unchanged |

**Stack (decided — from the repo) / 技术栈（已定，沿用仓库）:** Python + FastAPI + SQLAlchemy + SQLite (managed with `uv`), Next.js 16 + TypeScript + react-leaflet + Tailwind. YOLO (ultralytics) runs in the backend.

## 4. Data / 数据
> 中文摘要：只用已经测试通过的数据源；每条数据带时间戳和可信度。

| Source | Access (tested 2026-09-25) | Used for |
|---|---|---|
| Train Watch ArcGIS | ✅ public, live | crossing status, time-to-clear |
| TranStar camera snapshots | ✅ public, officials OK'd use; freeway refresh ≈ 2 min, street slower | congestion via YOLO |
| TranStar RSS (incidents, closures, travel times) | ✅ public, live, officials OK'd use | live adjustments, alerts |
| TranStar historical travel times | ✅ public (50 routes, 2011–2025) | baseline per 15-min slot |
| Vision Zero HIN 2025 | ✅ public (1,080 segments) | crash-risk cost |
| Small road graph (repo `seed/network.py`) | ✅ in repo | routing (decided: no TomTom for now; TomTom/OSRM only as a later option) |

**Tables / 表:** keep the repo's models (`Node`, `RoadSegment`, `RailCrossing`, `Camera`, `ScoreEntry`, `Trip`, `TripState`, `Notification`). Add: `MultiStopPlan(id, device_id, request_json, result_json, created_at)`, `CameraObs(ts, camera_id, md5, valid, reason, vehicles)`, `CrossingObs(ts, crossing_id, status, sensor, time_to_clear, time_updated)`. Extend `Trip` → stops list lives in `MultiStopPlan.request_json`.
The weekend logger (`spikes/logger.py`) writes a compatible subset; import its SQLite into these tables and replay through `clock.py`.

## 5. Planner / 规划算法
> 中文摘要：3 个站点只有 6 种顺序，直接全部试遍；每种顺序再试多个出发时间，选成本最低的。

- Enumerate all orders (≤ 3 stops → 6) × departure offsets (every 15 min, next 2 h; refine best to 5 min).
- Each leg = repo `route(origin, destination, depart_at, safe_path)` on the small graph (edge cost already includes congestion, train delay and crash exposure per `ARCHITECTURE.md`). Live overrides: RSS travel time and YOLO camera congestion on a segment replace the predicted congestion when the leg starts within 30 min.
- Crossings: repo train model (`p_block`, expected delay) + live `active_blockages` from Train Watch (remaining `timeToClear`).
- Cost = drive + 0.5 × wait-at-stop + 0.3 × minutes-of-delayed-departure + w × crash-risk (w user-adjustable, "faster ↔ safer").
- Hard constraint: arrive inside each stop's window; if impossible, return the plan with the fewest late stops and say so.
- Re-plan every 5 min; alert only if leave-time moves ≥ 5 min or order changes.

## 6. Error handling & trust / 错误处理与可信度
> 中文摘要：看不清就说“不确定”；数据源挂了就降级，不崩溃。

- Every value shown with "updated x min ago".
- Crossing with `sensorStatus != UP` → shown as **low confidence** (meaning unknown; officials didn't know). Still used, flagged in alert text.
- Snapshot invalid (non-image, < 3 KB, corrupt) or unchanged > 15 min (freeway) / > 30 min (street) → excluded, camera marked stale.
- Camera congestion = count vs that camera's own median, never absolute counts (YOLO undercounts small cars on 320×240 frames).
- Source down → adapter falls back to the repo's mock/synthetic scores for that source; UI says which source is missing.
- Any API key (none needed today) only on the backend.

## 7. Testing / 测试
> 中文摘要：规划器用固定数据做单元测试；整体流程用回放数据测试。

- Unit: planner on fixed fixtures (known matrix + windows → expected order/time); crossing penalty; window violations; frame validation.
- Integration: replay a logged hour → plan → inject block → assert re-plan + alert.
- Manual: 3 real drives this weekend, log our prediction vs Google vs actual (the only real "better than Google" evidence).

## 8. Demo script / 演示流程 (≈ 3 min)
1. Problem slide: 77 h/yr, 700+ crossings, blind spots.
2. Phone: enter UH Sugar Land → UH main (by 5 PM) → Ion (by 6 PM) → plan appears (sample result below).
3. Replay a logged train blockage on an East End route → push alert "Change plan…, saves N min".
4. Live view: cameras + crossings + Waze panel.
5. Close: normal −6 min / disruption −54 min; data we collected is data nobody else archives.

**Sample result (spike `spikes/demo_trip.py`, typical weekday, TranStar 2025 history):** leave UH Sugar Land by **3:55 PM** (safer 3:50) → ~56 min drive, arrive ~4:51 PM; leave UH by **5:40 PM** → Ion ~5:50 PM. At 5 PM Friday live RSS showed I-69 SW inbound 610 → Downtown at 29 min — far worse than history, exactly the case live re-planning covers.

## 9. Risks / 风险
1. Scope creep (5 people, ~50 h) → build M1–M5 end-to-end by **Sat noon**, bonuses after.
2. Train Watch DOWN sensors of unknown meaning → low-confidence label, cross-check, log to evaluate.
3. Hazard matching false positives: freeway passing *over* a street matches that street's crash segment / crossing (seen in demo) → require name match or heading alignment before counting.
4. iPhone web push needs "Add to Home Screen" → set up demo phone in advance.
5. Logger must run all weekend on an always-on machine.

## 10. Open questions / 待定
- Q6: team roles (stack now fixed by the repo).
- Graph coverage: the small graph only covers corridors in `seed/network.py`; stops outside it snap to the nearest node — add nodes for every demo location.
- US Accidents download (optional, intersection-level detail).
- Project name.

## Decisions log / 决策记录
- 2026-09-25: routing = repo's small graph (+ add demo places), not TomTom / 路线用小路网
- 2026-09-25: multi-stop with time windows = yes / 做多站点
- 2026-09-25: YOLO camera congestion = yes (overrides repo brief's "no CV") / 做 YOLO
- 2026-09-25: stack = repo's (FastAPI + SQLAlchemy + uv, Next.js + TS + react-leaflet) / 技术栈沿用仓库
