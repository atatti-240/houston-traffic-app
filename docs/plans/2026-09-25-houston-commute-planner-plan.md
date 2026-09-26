# Implementation Plan / 实施计划 — Houston Commute Planner

Spec / 设计文档: [2026-09-25-houston-commute-planner-design.md](../specs/2026-09-25-houston-commute-planner-design.md) (approved 2026-09-25)
Repo / 仓库: https://github.com/atatti-240/houston-traffic-app (base commit `dbe17e4`)
Deadline / 截止: **Sun 2026-09-27 11:45 PM** · Internal submit target / 内部提交目标: **Sun 10:00 PM**
API samples / 接口示例: `docs/contracts/*.json` (copy into the repo, see T0.3)

## How to use this plan / 怎么用
- Every task has: **Owner role · Files · Depends on · Estimate · Steps · Done when**. Owner letters match the roles in `docs/outline.md` §10 (A Live data, B Camera AI, C Planner, D Website, E Safety + demo).
- 每个任务都写了负责人、文件、依赖、预计时间、步骤和完成标准。
- The repo already has Claude Code prompts 5–9 in `_bmad-output/planning-artifacts/claude-code-build-prompts.md`. Where a task says "Repo Prompt N", paste that prompt **plus** the "Changes vs repo prompt" lines below it.
- 仓库里已有第 5–9 步的 Claude Code 提示词；任务里写“Repo Prompt N”的，贴原提示词再加上“改动”那几行。
- One owner per file. If you must touch someone else's file, tell them first. / 每个文件只有一个负责人。
- Branch per role: `a-data`, `b-camera`, `c-planner`, `d-web`, `e-safety`. PR into `main` before each checkpoint. / 每个角色一个分支，检查点前合并。

## Checkpoints / 检查点
| When | Gate | Must be true |
|---|---|---|
| **Sat 12:00** | CP1 crude end-to-end / 流程串通 | Phone browser: pick UH Sugar Land → UH → Ion, press Plan, see leave-by times and route on the map (data can still be mock) |
| **Sat 21:00** | CP2 must-haves / 必做完成 | M1–M5 from the spec work on real data; re-plan alert fires in replay |
| **Sun 15:00** | Feature freeze / 功能冻结 | Only bug fixes after this |
| **Sun 22:00** | Submitted / 已提交 | Devpost filled, video uploaded, repo public and runnable |

---

## Phase 0 — Friday night (everyone, ~1 h) / 第 0 阶段：周五晚上

### T0.1 Setup on every laptop / 每台电脑装环境 — Owner: all · 30 min
1. Install `uv` (`pip install uv` or the official installer) and Node 20+.
2. `git clone https://github.com/atatti-240/houston-traffic-app && cd houston-traffic-app`
3. `make setup && make seed && make test` (on Windows without `make`: run the commands inside `Makefile` by hand).
4. `make dev` → open http://localhost:3000 (blank map) and http://localhost:8000/docs.
**Done when:** tests pass and both servers start on your machine. / 测试通过、两个服务都能启动。

### T0.2 Keep the real-data logger running / 数据记录程序持续运行 — Owner: A · 10 min
1. On one always-on computer (plugged in, sleep off): from the repo root in PowerShell: `.\spikes\.venv\Scripts\python.exe .\spikes\logger.py` (create the venv first, see `spikes/README.md`)
2. Check once tonight: `.\spikes\.venv\Scripts\python.exe .\spikes\log_report.py`
**Done when:** report shows new ticks and 0–few errors. / 报告里有新记录。

### T0.3 Put shared docs into the repo / 把共享文档放进仓库 — Owner: E · 15 min
1. Copy into the repo: `docs/contracts/*.json`, the spec, this plan, `docs/outline.md`, `docs/feature-notes.md` → `docs/` in the repo.
2. Copy `docs/contracts/*.json` also to `frontend/public/mock/` so D can build against them.
3. Add one line to the repo `README.md`: "Design: docs/specs/…; plan: docs/plans/…".
4. PR → `main`.
**Done when:** everyone can open the contracts from the repo. / 大家都能在仓库里看到接口示例。

### T0.4 Create branches / 建分支 — Owner: all · 5 min
`git checkout -b <your-branch>` (see list above).

---

## Phase 1 — Saturday 9:00–12:00 → CP1 / 第 1 阶段

### T1.A1 Add demo places + links to the graph / 路网加地点 — Owner: A · 1 h · Depends: T0.1
**Files:** `backend/app/seed/network.py`, `backend/tests/test_network.py`
**Steps:**
1. Add nodes to `NODES` (is_place=True): `uh_sl` "UH Sugar Land" (29.5747, -95.6480), `uh` "UH main campus" (29.7199, -95.3422), `ion` "Ion District" (29.7336, -95.3790).
2. Add `LINKS`:
   - `LinkDef("I69", "I-69", "Southwest Fwy", "uh_sl", "i69_bw8sw", congestion_mult=1.1)`
   - `LinkDef("CULL2", "Cullen", "Cullen Blvd", "uh", "ost_cullen", "arterial")`
   - `LinkDef("SCOT2", "Scott St", "Scott St", "uh", "gulf_ee", "arterial")`
   - `LinkDef("WHLR", "Wheeler", "Wheeler Ave", "uh", "ion", "arterial")`
   - `LinkDef("MAIN2", "Main St", "Main St", "ion", "midtown", "arterial")`
3. Test: routes exist `uh_sl→uh`, `uh→ion` (graph connectivity check via `load_network`).
**Done when:** `make seed && make test` pass; new places appear in `Network.places()`.

### T1.C1 Routing engine / 路线引擎 — Owner: C · 2 h · Depends: T0.1
**Repo Prompt 5** (routing + Safe Path).
Changes vs repo prompt: none. Keep the `route(origin, destination, depart_at, safe_path)` signature from `ARCHITECTURE.md`.
**Done when:** repo prompt's tests pass (Safe Path changes a route; a crossing is avoided at its high-blockage time).

### T1.C2 Departure recommender (single leg) / 出发时间推荐 — Owner: C · 1 h · Depends: T1.C1
**Repo Prompt 6, part 1 only** (`recommender.py`). Notifications come in T2.C2.
**Done when:** `recommend_departure("uh_sl", "uh", "17:00", False)` returns a departure that arrives ≤ 16:55 and leaves earlier than for an `arrive_by` of `14:00` + the same gap (rush hour is slower). Exact times depend on T1.E2 seeding real history.

### T1.C3 Minimal API for CP1 / 最小 API — Owner: C · 45 min · Depends: T1.C2
**Files:** `backend/app/api/` (new routers), `backend/app/main.py`
**Steps:** add `GET /places`, `POST /recommend` (repo prompt 7 shape) and a first `POST /plan` that accepts `docs/contracts/trip_request.json` and, for now, chains `recommend_departure` leg by leg in the given order (real multi-stop comes in T2.C1). Response shape = `plan_result.json` (fields you can't fill yet → `null`).
**Done when:** `curl -X POST localhost:8000/plan -d @docs/contracts/trip_request.json` returns JSON with the same keys as `plan_result.json`.

### T1.D1 Trip input + plan view on mock JSON / 行程输入 + 计划页面 — Owner: D · 4 h (incl. theme + landing) · Depends: T0.3
**Files:** `frontend/app/page.tsx`, `frontend/components/*` (new: `TripForm.tsx`, `PlanCard.tsx`, map layers in `MapView.tsx`)
**Steps:**
1. Trip form: start + up to 3 stops (dropdown from `GET /places`, fallback to a hard-coded list), each with window start/end time; Safe Path toggle; Plan button.
2. Plan view: big "Leave by 3:55 PM" per leg, arrive time, drive minutes, `why` list, "Go" buttons (Waze + Google links from `navigate_links`).
3. Map: draw each leg's `geometry`, markers for stops.
4. Load `/mock/plan_result.json` when the API is down (`NEXT_PUBLIC_USE_MOCK=1`).
5. Phone layout first (375 px wide), Tailwind. **Style = `docs/website-style.md`** (dark navy, Overpass + Fira Sans, blue/yellow accents, based on the Space Apps Houston site — look only, no NASA branding). Start by pasting its `globals.css` block and switching map tiles to CARTO Dark Matter.
6. Add a short landing page (`/`) per style guide §3; the planner moves to `/plan`.
**Done when:** on a phone-sized browser the mock plan renders; switching the flag calls the real `POST /plan`.

### T1.B1 Camera adapter + YOLO service (standalone) / 摄像头 + YOLO — Owner: B · 3 h · Depends: T0.1
**Files:** `backend/app/adapters/real/cameras.py` (new), `backend/app/adapters/real/__init__.py`, `backend/pyproject.toml` (optional group `vision = ["ultralytics"]`), `backend/tests/test_cameras.py`
**Reuse:** `spikes/logger.py` (`pick_cameras`, `validate`, YOLO call), `spikes/crossing_cams/` findings.
**Steps:**
1. `RealCameraSource(CameraSource).cameras()`: download `https://traffic.houstontranstar.org/data/layers/cctvSnapshots_out.js`, parse, keep cameras within 300 m of any graph segment, return dicts `{id, kind:"highway", name, lat, lng, url: snapshot_url, segment_id}`.
2. `validate(content_type, body)` → reject non-image, < 3 KB, corrupt JPEG (same as spike).
3. `count_vehicles(jpeg_bytes) -> int` using `yolov8s.pt`, `imgsz=1280`, `conf=0.2`, classes car/motorcycle/bus/truck.
4. Unit tests with 2–3 saved JPEGs from `spikes/snapshots/` (put copies in `backend/tests/fixtures/`), plus one HTML body → invalid.
**Done when:** `pytest tests/test_cameras.py` passes; `cameras()` returns ≥ 30 cameras on the graph.

### T1.E1 Vision Zero crash prior / 事故风险先验 — Owner: E · 2 h · Depends: T0.1
**Files:** `backend/app/adapters/real/visionzero.py` (new), `backend/scripts/load_visionzero.py` (new), test
**Reuse:** `spikes/crash_hotspots.py`, `spikes/hin2025_segments.json`
**Steps:**
1. Fetch `https://services.arcgis.com/NummVBqZSIJKUeVR/arcgis/rest/services/HIN2025_All_WK/FeatureServer/3/query?where=1%3D1&outFields=*&outSR=4326&f=json&resultRecordCount=2000`.
2. For each graph `RoadSegment`, sum `Total_Crash_Count` of HIN segments whose midpoint is within 150 m of the segment geometry **and** whose `Full_Name` matches the segment's street (fixes the overpass false positive from the spike).
3. Write the result as the crash model's starting value per segment (`ScoreStore.ema(...)` first observation) for every crash bucket.
4. Keep `top_hin_segments(bbox)` for map warnings (used by D in T2.D2).
**Done when:** after `scripts/load_visionzero.py`, `CrashRiskModel.top_risky(...)` lists segments on Westheimer / Main / Scott ahead of freeway segments with no HIN match.

### T1.E2 TranStar historical travel times → congestion seed / 历史行车时间 — Owner: E · 1.5 h · Depends: T1.A1
**Files:** `backend/app/adapters/real/transtar_speed.py` (new), `backend/scripts/load_transtar_history.py` (new)
**Reuse:** `spikes/demo_trip.py` (`hist_route`)
**Steps:**
1. Parse `https://traffic.houstontranstar.org/hist/traveltimes_web.aspx?id=<id>&year=2025` → `{slot: seconds}` + free-flow.
2. Mapping table (start with the demo corridor):
   | TranStar id | Route | Graph links |
   |---|---|---|
   | 11 | US-59 SW inbound SH-99 → 610 | `uh_sl→i69_bw8sw`, `i69_bw8sw→i69_610sw` |
   | 12 | US-59 SW inbound 610 → Downtown | `i69_610sw→midtown`, `midtown→downtown` |
   | 13, 14 | US-59 SW outbound | reverse of the above |
3. Convert to `SpeedObservation(segment_id, slot, speed_mph)` for weekdays (speed = segment miles ÷ (route seconds × segment share)); feed `CongestionModel.update_from_observations` for 8 replayed weekdays.
**Done when:** congestion score on `i69_bw8sw→i69_610sw` at Monday 4:00 PM is clearly higher than at 2:00 PM.

### ✅ CP1 check (Sat 12:00, 15 min, all) / 检查点 1
Merge A1, C1–C3, D1 into `main`. Run `make dev`, do the demo trip on a phone. List what broke; fix before 1 PM.

---

## Phase 2 — Saturday 12:00–21:00 → CP2 / 第 2 阶段

### T2.C1 Multi-stop planner / 多站点规划 — Owner: C · 2.5 h · Depends: T1.C2
**Files:** `backend/app/multistop.py` (new), `backend/tests/test_multistop.py`, `api/` `POST /plan`
**Reuse:** `spikes/must_have_test.py` (`simulate`, `best_plan`)
**Steps:**
1. `plan(start, stops, depart_after, safe_path, safety_weight, buffer_min, now) -> Plan` per spec §5: all orders (≤ 3 stops) × departures every 15 min for 2 h, refine best ±15 min at 5-min steps; each leg via `route(...)`.
2. Cost = drive + 0.5·wait + 0.3·delay-minutes + safety_weight·crash exposure; windows are hard constraints; if none feasible return fewest late stops with `status: "late"`.
3. Baseline for `saved_min_vs_baseline` = typed order, leave at `depart_after`.
4. Tests: (a) fixed toy graph where reordering saves time; (b) window forces a later departure; (c) infeasible windows → `status:"late"`; (d) blocked crossing on leg 1 changes order or time.
**Done when:** tests pass; with T1.E2's real history loaded, `POST /plan` with `trip_request.json` returns leave-by within ±15 min of the spike result (3:55 PM leg 1, 5:40 PM leg 2).

### T2.A2 Train Watch adapter + real crossings / 真实道口 — Owner: A · 2 h · Depends: T1.A1
**Files:** `backend/app/adapters/real/trainwatch.py` (new), `backend/app/seed/network.py` (crossings), `backend/app/adapters/__init__.py` (`build_sources("real", …)`), `backend/app/config.py` (`DATA_SOURCE=real`)
**Reuse:** `spikes/logger.py` (`TW_URL`), `spikes/must_have_test.py` (`pull_crossings`)
**Steps:**
1. `TrainWatchSource(TrainSource)`: `active_blockages(now)` → currently `blocked` crossings with remaining minutes from `timeToClear`; `crossing_events(day)` → sessions built from the logger DB (`crossing_obs`) for replayed days.
2. Attach each real Train Watch crossing to the nearest graph arterial segment within 800 m (e.g. Commerce St → `NAV`); keep the repo's modeled crossing only where no real one is close; store `confidence = "low"` when `sensorStatus != "UP"`.
3. `build_sources("real")`: real Train/Speed/Crash/Camera sources, each falling back to its mock on error.
**Done when:** with `DATA_SOURCE=real`, `GET /crossings` returns real street names and statuses; unplugging the network falls back to mock without crashing.

### T2.A3 Import weekend logs for replay / 导入周末数据 — Owner: A · 1 h · Depends: T2.A2
**Files:** `backend/scripts/import_logger.py` (new), models `CrossingObs`, `CameraObs` (spec §4)
**Steps:** read `spikes/data/log.db` tables `crossings`, `frames` → insert into the new tables (UTC → local); expose `obs_at(now)` used by `TrainWatchSource` / camera override when `clock` is simulated.
**Done when:** setting the sim clock to a logged time shows the crossings that were really blocked then.

### T2.B2 Live camera congestion override / 摄像头实时拥堵修正 — Owner: B · 2.5 h · Depends: T1.B1, T2.A3
**Files:** `backend/app/adapters/real/cameras.py`, `backend/app/scoring/congestion.py` (small hook), `backend/scripts/collect_cameras.py` (new)
**Steps:**
1. `collect_cameras.py`: every 60 s fetch the graph's cameras, validate, run YOLO only when md5 changed, write `CameraObs`.
2. Baseline per camera = median `vehicles` of its last N valid frames (seed from logger import).
3. `congestion_now(segment_id, now) -> float | None`: latest fresh frame (≤ 10 min freeway / ≤ 30 min street) → ratio to baseline mapped to [0, 1]; `None` if stale / invalid.
4. `CongestionModel.get_segment_travel_time`: if `congestion_now` is not `None` and `at` is within 30 min of `now`, blend 50/50 with the predicted score.
5. Mark cameras stale after 15 min (freeway) / 30 min (street) unchanged.
**Done when:** a replayed jammed frame on I-69 raises the leg-1 drive time; frozen camera `8031` shows `stale: true` in `GET /live`.

### T2.C2 Scheduler + notifications / 调度 + 推送 — Owner: C · 1.5 h · Depends: T2.C1
**Repo Prompt 6, part 2** (notifications + scheduler).
Changes vs repo prompt: the scheduler re-runs `multistop.plan` for saved `MultiStopPlan`s every tick (not single trips); alert when leave-time moves ≥ 5 min or order changes, text includes the reason (e.g. "Train blocking Commerce St, low confidence").
**Done when:** `POST /demo/advance-clock` across a replayed blockage creates a `Notification` with the reason.

### T2.C3 Rest of the API / 其余 API — Owner: C · 1 h · Depends: T2.C1, T2.A2, T2.B2
**Repo Prompt 7** + `GET /plan/{id}` + `GET /live` (shape = `docs/contracts/live_conditions.json`).
**Done when:** each endpoint has one API test; `/docs` lists them.

### T2.D2 Live view, alerts, Waze panel / 实时页面 + 提醒 — Owner: D · 3 h · Depends: T1.D1, T2.C3 (mock until then)
**Files:** `frontend/components/LiveView.tsx`, `AlertsDrawer.tsx`, `WazePanel.tsx`, `MapView.tsx`
**Steps:**
1. Map layers (toggle): crossings (red blocked / green clear / grey low-confidence), cameras (colored by `congestion`, click → snapshot + "updated x min ago"), high-injury segments (red outline), incidents.
2. Alerts drawer polling `GET /notifications` every 10 s; toast on new.
3. Waze panel: `<iframe src="https://embed.waze.com/iframe?zoom=13&lat=…&lon=…">` in its own panel (not over our map).
4. "Updated x min ago" on every live item.
**Done when:** with the API running, the live view shows real crossings and camera thumbnails; a replayed alert appears as a toast.

### T2.E3 Demo scenario + replay button / Demo 场景 — Owner: E · 2 h · Depends: T2.A3, T2.C2
**Repo Prompt 9, part 1**, changed to our scenario:
1. Monday 3:30 PM sim: plan UH Sugar Land → UH (by 5) → Ion (by 6) → leave-by 3:55 PM.
2. Advance clock; replay a logged East End blockage near the route (or inject via `/demo/block-crossing`) → alert "Leave N min earlier / change order".
3. Flip Safe Path → route avoids a high-injury segment.
**Done when:** one button on `/demo` runs all three steps in < 60 s.

### ✅ CP2 check (Sat 21:00, 30 min, all) / 检查点 2
Merge everything. Run the demo scenario 2× on a phone. Anything not working → decide: fix tonight or cut.

---

## Phase 3 — Sunday 9:00–15:00 (bonus + hardening) / 第 3 阶段：加分项
Pick in this order; stop at 15:00. / 按顺序做，15:00 停止。
| # | Task | Owner | Est |
|---|---|---|---|
| T3.1 | PWA manifest + service worker + web push (iPhone: add to home screen) | D | 2 h |
| T3.2 | Queue detection near crossings (YOLO count spike at the intersection camera next to a crossing → "likely blocked") | B | 2 h |
| T3.3 | "Train blocking here" report button → `POST /report` → low-confidence live block | A + D | 1.5 h |
| T3.4 | Safe-route slider (faster ↔ safer) → `safety_weight` | D + C | 1 h |
| T3.5 | Blocked-crossing report export (CSV of logged sessions) for the city | A | 45 min |
| T3.6 | EN / ES toggle for the main screens | D | 1 h |
| T3.7 | Test pass: `make test` green, add missing tests for multistop + adapters | C + B | 1 h |

## Phase 4 — Sunday 15:00–22:00 (ship) / 第 4 阶段：交付
| Time | Task | Owner |
|---|---|---|
| 15:00 | Feature freeze; bug list | all |
| 15:00–17:00 | 3 real drives (or Google ETA snapshots): record our leave-by + predicted time, Google's time, actual time → one slide | E |
| 16:00–18:00 | Slides: problem → demo → evidence (−6 / −54 min, real drive results) → how real data plugs in → future partners (TRAINFO, RailState) | E |
| 18:00–19:00 | Record a 2–3 min backup demo video | D + E |
| 19:00–20:30 | Rehearse 3× with a timer | all |
| 20:30–22:00 | Devpost write-up, README "How to run" + "Data sources", repo public, submit | E + C |

---

## Dependency map / 依赖关系
```
T0.1 ─┬─ A1 ─┬─ E2
      │      └─ A2 ── A3 ──┬── B2 ──┐
      ├─ C1 ── C2 ─┬─ C3(min)       ├── C3(full) ── D2 ── E3 ── CP2
      │            └─ C1' multistop ─┴── C2' scheduler ─┘
      ├─ B1 ─────────── B2
      ├─ E1
      └─ T0.3 ── D1 (mock) ──────────── D2
```
Critical path / 关键路径: **C1 → C2 → multistop → scheduler → demo**. If C falls behind, A or E pairs with C; D keeps working on mock JSON.

## Known risks while building / 开发中的风险
1. `uv` / Next.js setup issues on Windows → fix in T0.1 tonight, not Saturday.
2. Small graph realism: straight-line segment geometry looks odd on the map → optional: fetch OSRM geometry once per link at seed time (A, 30 min) if time allows.
3. YOLO CPU load on the demo laptop → YOLO runs only on changed frames; demo can use replayed counts.
4. Train Watch `DOWN` sensors → always shown as low confidence; never the only reason for a big re-plan without saying so.
5. Merge conflicts in `network.py`, `api/`, `models.py` → owners A, C, A respectively; others ask first.
