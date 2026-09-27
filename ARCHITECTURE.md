# Architecture

BlindSpot tells commuters **when to leave and which way to go** before traffic hits. It predicts congestion, crash risk and freight-train crossing blockages from historical data, instead of only reacting to live jams.

Hackathon-sized: one Python backend, one Next.js frontend, one SQLite file. Every external feed sits behind an interface with a synthetic **mock** implementation, so the app runs end to end with no API keys.

```
                +------------------------------ backend (FastAPI) --------------------------------+
                |                                                                                 |
 DataSources -->|  adapters/            scoring/              conditions/        routing/          |
 (mock today,   |  history:                                                                       |
  TranStar /    |  SpeedSource    --> CongestionModel --+                                          |
  TrainWatch    |  CrashSource    --> CrashRiskModel  --+--> ConditionsView --> Router              |
  later)        |  TrainSource    --> TrainBlockModel --+    (one snapshot:     (time-dep.          |
                |  live:                                     predictions +      Dijkstra)           |
                |  TrainSource.crossing_status -----------> live data +           |                 |
                |  LiveTrafficSource.current   ----------->  priority rules +     +--> recommender  |
                |  IncidentSource.active       ----------->  confidence)          +--> planner      |
                |  CameraSource                                                    |    (multi-stop) |
                |                   ScoreStore (EMA, SQLite)                        v                 |
                |                                                     notifications/ scheduler      |
                |                         api/ (REST, OpenAPI at /docs)                             |
                +------------------------------------------+--------------------------------------+
                                                           |
                                               frontend (Next.js PWA + Leaflet)
```

## Components

| Component | Where | Job |
|---|---|---|
| Data-source adapters | `backend/app/adapters/` | Abstract interfaces. History: `SpeedSource`, `CrashSource`, `TrainSource.crossing_events`. Live: `TrainSource.crossing_status`, `LiveTrafficSource`, `IncidentSource`. Plus `CameraSource`. `Mock*` implementations are built on the synthetic generator, and the demo can inject live data or take a feed down. Picked by `DATA_SOURCE` config (`mock` only for now). |
| Road-conditions layer | `backend/app/conditions/` | The only thing the router reads. For a segment or crossing at time T it combines the model predictions with live data by fixed priority rules, and records the confidence and source of every input. See [docs/routing-wiring.md](docs/routing-wiring.md). |
| Scoring models | `backend/app/scoring/` | Three models with the same shape: key = (entity, time bucket), value updated by an exponential moving average. |
| Score store | `backend/app/scoring/store.py` | Persists scores in the `score_entries` table and caches them in memory for fast routing. |
| Routing engine | `backend/app/routing/` | Time-dependent Dijkstra-style search over the road graph with a blended cost and a 0-1 safety weight (the Faster ↔ Safer slider). It keeps several labels per node (time so far vs. penalty so far), because once roads can be waited on, reaching one later can be the better choice. |
| Causes engine | `backend/app/causes.py`, `api/causes.py` | "Why is it slow?" Splits every road's delay into causes (rush hour, busier than usual, crash, construction, closure, event, weather, train) and powers the map's cause icons, the "Why it's slow" screen, traffic alerts and "notify me when it clears". See [Why it's slow](#why-its-slow). |
| Directions | `backend/app/directions/`, `api/directions.py` | Door-to-door directions on real roads (public OSRM), turn-by-turn steps with lane arrows, and up to 3 different routes to pick from. See [Directions](#directions). |
| Departure recommender | `backend/app/recommender.py` | Tries departures every 5 minutes and picks the latest one that still arrives on time. Also returns a `leave_at_safe` with a margin that grows as confidence drops. |
| Multi-stop planner | `backend/app/planner.py`, `plan_io.py` | Up to 3 stops with time windows, dwell and fixed-order stops. Picks the stop order and every departure time, and compares the result against a leave-now baseline in the typed order. |
| Notifications | `backend/app/notifications/` | `NotificationService` interface (mock = stored in DB, WebPush = stub) + a scheduler that re-checks saved trips and watched plans on each clock tick. |
| Simulated clock | `backend/app/clock.py` | The whole app reads "now" from here. It runs at `CLOCK_SPEED` × real time from `SIM_START` (a Monday 7:15 AM), and the demo can jump it. |
| Services | `backend/app/services.py` | Wires network + models + router + scheduler + clock together for the API. |
| REST API | `backend/app/api/` | FastAPI routers. |
| Frontend | `frontend/` | Next.js PWA, dark theme. One Leaflet map (over a free MapLibre vector street map from OpenFreeMap) stays mounted under every screen: Where to, Trip, Live map, Causes, Why it's slow, Alerts and Live cams. Full-screen panels on a phone, a 420px side panel next to the map on desktop. Plus the scripted demo. |

## Time buckets

- **Congestion and train blockage:** `(day_of_week, 15-min slot)`, i.e. 7 × 96 = 672 buckets. Stored as the string `d{dow}s{slot}`, e.g. `d0s30` = Monday 07:30.
- **Crash risk:** crashes are rare, so buckets are coarser: `(weekday|weekend, hour)`, stored as `wd-h07` / `we-h22`. That gives ~5× more observations per bucket.

## Models

All three models use the same EMA update, where `alpha` is the "nudge factor":

```
score = score + alpha * (observation - score)      # first observation initializes
```

The team's first idea was `score += today * factor`, which grows without bound. The EMA settles on the typical value and still follows sustained change.

| Model | Entity | Observation per bucket per day | Output |
|---|---|---|---|
| Congestion | road segment | `1 - observed_speed / free_flow_speed`, clamped to [0, 1] | score in [0, 1]; travel time = free-flow time / (1 - 0.85·score) |
| Crash risk | road segment | crashes in bucket / segment miles | risk in [0, 1] = `1 - exp(-rate / CRASH_RATE_SCALE)`; starts from a small prior |
| Train block | rail crossing | blocked at any point in bucket (0/1) and blocked minutes | `p_block`; `expected_delay = p_block × avg_block_min × 0.5` (on average you arrive halfway through a blockage) |

**Live data** doesn't go into the models. It goes into the road-conditions layer, which blends it with the predictions for about the next 30 minutes:

| Input | Rule |
|---|---|
| Crossing reported blocked | Wait until it clears. Confidence high, or low if the sensor is down (still used) |
| Crossing reported clear, sensor up | No wait if you arrive within 5 min. After that, back to the prediction |
| Crossing sensor down or status older than 15 min | Prediction, low confidence |
| Live congestion reading | Only while fresh (10 min freeway, 30 min street). Blend weight `0.8 × (1 − minutes_ahead/30) × confidence factor` |
| Incident | A closure shuts the road until it clears (the router waits or goes around). Crash ×1.6, lane closure ×1.5, weather ×1.35, roadwork or event ×1.3, stall, hazard or other ×1.2, +0.25 per extra lane, max ×3, until it clears (default 45 min) |
| Feed down | Predictions only, low confidence for the next 30 min (every road when the traffic or incident feed is down, crossings when the train feed is), and the route says so |
| Time more than 15 min before now | Live traffic and crossing status ignored; incidents count only if they had started by then (live data describes the present) |

Every road and crossing on a route carries its `confidence` (high / medium / low), its `source` and when that was last updated. A route is **low** if any input that matters (live data, an incident or closure, a likely crossing, or anything already low) is low. It is **high** when at least half the drive time rests on strong live readings (blend weight ≥ 0.4) and no predicted crossing has a ≥10% chance of a train. Otherwise it is **medium**.

## Routing

The graph has nodes (interchanges and places) and directed `RoadSegment` edges. Some segments carry `RailCrossing`s. For a departure time `t` the router accumulates the arrival time at each segment and scores each edge as:

```
edge_cost = travel_time(seg, t_seg)                     # congestion (predicted, blended with live) x incident slowdown
          + sum(expected_delay(crossing, t_crossing))    # train model, or the live blockage
          + lambda_crash * crash_risk(seg, t_seg) * seg_miles
lambda_crash = 30 + safety_weight * (600 - 30)  s/mile   # slider: 0 = fastest, 1 = safest (= old safe_path)
```

A closed road is a wait: the route reaches it, waits for the closure to clear, then drives it (like a blocked crossing), so the search waits or goes around, whichever is cheaper.

It returns the best route, one alternative (found by penalizing edges of the best route), a breakdown (base travel, train delay, crash exposure) and human-readable "why" reasons. To explain its choice, it also computes:
- a **traffic-only route** (congestion-aware but blind to trains and crash risk, roughly what a typical nav app picks; it sees closures but not train waits). Hazards on it that the chosen route skips become "Avoided X: 72% chance of a train around 7:38 AM".
- when live data is in play, the route it *would* have picked on predictions alone. Roads it skips because of live data become "Rerouted around X: crash reported (demo feed, just now)" or "heavier traffic than usual right now (traffic camera, 2 min ago)".
- when a feed is down, a first bullet saying the route is running on predictions.

## Why it's slow

Maps paint a road red. `CausesEngine` (`app/causes.py`) says why. It reads the same `ConditionsView` as the router, so it always agrees with the routes. For each road segment at time T, the delay against free flow is split into parts:

| Part | How | Cause shown |
|---|---|---|
| Usual | predicted travel time − free flow | **Rush hour** on weekdays 6:00-9:30 and 15:30-19:00, otherwise **Usual traffic** |
| Volume | live-blended travel time − predicted | **Higher than usual volume** (camera counts, TranStar) |
| Incident | live travel time × (incident factor − 1) | crash, stall or hazard → **Crash**, roadwork → **Construction**, lane closure or closure → **Closure**, **Event**, **Weather** |
| Closure | wait until a closed road reopens | **Road closure** |
| Train | expected wait at the road's rail crossings | **Train** |

- **Status** comes from effective speed vs. free flow: heavy under 50%, moderate under 75%, otherwise light. A road is a slowdown if it's moderate or heavy, closed, or at least 3 min slower than free flow.
- **Shares** of the delay are rounded to whole percents that add up to 100.
- **Routine causes** are rush hour / usual traffic, and a train predicted from history at under 50% ("Chance of a train at the crossing"; 50% or more is "Train likely at the crossing"). They stay in the breakdown, but they never make a road unusual. A live train is never routine.
- **The main cause** is the first non-routine cause with at least 25% of the delay, otherwise the biggest one (a routine train chance only when it's the only cause). So a crash at 5 PM still shows as a crash, not as rush hour, and a 13% chance of a train doesn't.
- **On the map** every slowdown with a non-routine main cause gets an icon, plus the 3 worst routine roads. The icon sits 55 m to the right of travel, on the line for that direction.
- **History** for the "Why it's slow" chart: speed every 10 min over the last 2 h, the usual speed and free flow, and a marker where each cause started. Each point only counts incidents that had started and live readings taken by then (like live trains), so the speed never drops before its marker.

Endpoints: `GET /slowdowns` (every slowdown, worst first), `GET /slowdowns/{segment_id}` (causes, history, whether you're watching it), `POST`/`DELETE /slowdowns/{segment_id}/watch` ("notify me when it clears"), `GET /traffic-alerts` (incidents, roadwork, events, weather, trains and busier-than-usual roads, each with its impact) and camera status in `GET /live` (area, direction, level, delay, weather). A train alert's delay is the train cause on the crossing's worse road (the one it opens), not the wait at the gate right now. A crossing camera reports the worse of the crossing's two directions, plus `crossing_blocked` (a live train blocking it now, same test as `/live` crossings; `null` for highway cameras). A highway camera's area is the place nearest the interchange it is named after.

A watch on a road with something unusual (a non-routine cause of at least a minute: a crash, a live train, rain...) clears when nothing unusual is left, even if it's still rush hour. A watch on any other road clears when it's back to light traffic. One rule (`causes.unusual`) decides both. While the incidents, traffic or trains feed is down, watches stay open and aren't checked, since a missing crash would look like "cleared". Watches expire after 12 h.

## Directions

Our router still picks the corridor (it knows traffic, trains and incidents), but it only knows the ~80 segments between interchanges, so on its own a trip to a shop stops at the nearest one. `app/directions` draws and describes the whole trip on real roads with the public OSRM router (OpenStreetMap, no key):

- **Door to door.** One OSRM request from the real start, through via points taken along our chosen segments' traced shapes, to the real end: `waypoints=0;<last>` so the vias are silent, a bearing on each via (from the traced line) so it lands on the right carriageway, `continue_straight=true`. Vias sit in the middle of straight stretches about every 5 km (at least one per segment), away from interchanges: our node points are approximate and can be far off the road (the I-45 / 610 North node is ~1.7 km from I-45), so the corridor is built from the traced shapes, not the node-pinned lines.
- **Checked, with fallbacks.** OSRM happily loops round a block or makes a U-turn to reach a via that snapped onto the wrong side. A result is rejected when the part along our roads is much longer or shorter than ours, the way on or off our roads is a long detour, the line drives back along itself, or it makes a U-turn at a via. Then (at most 3 calls): the same vias without the one that went wrong (or one per segment); then OSRM only for the way onto and off our roads with our own line and road names in between (`partial`); else our line and no steps (`unavailable`).
- **Times.** To or from an arbitrary point, the time is our traffic-aware time for the part of the corridor the trip drives (train and closure waits included where they fall) + OSRM's time for the way on and off it. Between our named places the place is the door and our own time stands. `/recommend` picks the departure again with that difference taken from the buffer, so departures stay on the usual 5-minute marks.
- **Steps.** OSRM has no instruction text; `steps.py` writes it from the maneuver type and modifier, road name and ref, exit numbers and signposted destinations ("Take exit 43A toward St Joseph Pkwy", "Merge onto I-45 Gulf Fwy"). Lane arrows come from the maneuver's own intersection (`intersections[0].lanes`), only where OpenStreetMap maps turn lanes and they say something (some lanes valid, some not). The step shape is documented in `frontend/lib/types.ts` (`RouteStep`).
- **Up to 3 routes.** The best route and the router's alternative, then the roads of every route found so far made dearer (1.5x, 2.5x, 4x). A route is kept only if it shares at most 75% of its length with each other one and is at most 40% (or 7 min) slower than the best. Each gets a label ("via I-610", the road that sets it apart), its main road and its biggest delays by cause.
- **Cost and politeness.** OSRM is never called from the recommender's or planner's loops, only for routes we send back. `/route` and `/recommend` build the first route's directions right away and send the others from the cache or as `pending`; the Trip screen asks `POST /directions` for those one by one (the picked route first). Results are cached by rounded endpoints + segment path (they don't depend on the time), two requests for the same trip share one build, and the client allows one request per second, gives up on a call after 4 s (and on a trip after 8 s), and after a failure stops asking for a minute, so a slow or dead server never hangs a request. `OSRM_URL` picks the server (`""` turns it off; the tests do).

API: `POST /route?directions=true` and `POST /recommend?directions=true` add `routes` (up to 3, `routes[0]` is `best` / `route`) with `id`, `label`, `main_road`, `delay_causes` and `directions` (`status`, `steps`, `distance_m`, `access_min`, `note`); `geometry` becomes the door-to-door line. Without the flag the answer is as before plus `routes` (no OSRM). `POST /directions` takes `origin`, `destination`, a route's `segment_ids` and `depart_at` and returns what changes in that route. The Trip screen keeps the picked route in its history entry and URL (`&route=<id>`); `/?screen=trip&to=29.739,-95.463&toName=The%20Galleria&from=downtown` opens a trip to a point.

## Request flow

1. The user saves a trip: origin, destination, arrive-by time, days of week, safety weight. Saving the same trip again (same device, places, time, days and safety) returns the one already saved instead of a copy that would alert twice.
2. `recommend_departure` tries departures from `arrive_by - 2h` to `arrive_by` in 5-minute steps, routes each one, and picks the latest one where `eta + buffer <= arrive_by`.
3. The scheduler runs on every clock tick (a background loop every 30 s, plus every `/demo/advance-clock`), starting 3 h before a trip's arrive-by time. It sends:
   - `plan` on the first check of the day ("leave at 7:35 AM via ...")
   - `leave_earlier` if the recommended departure moved ≥5 minutes earlier
   - `leave_later` if it moved ≥10 minutes later
   - `reroute` if the departure time held but the route changed (e.g. a live train)
   - `leave_now` once, when `now >= departure`. If a closed road means the best departure comes after the arrive-by time (leaving later arrives just as soon), the trip stays watched past arrive-by (for up to a day) until that "leave now" goes out. When the trip can't be on time, the plan alert gives the ETA and how late it will be.
4. Watched multi-stop plans (`POST /plan` with `watch: true`) are re-planned every 5 min until the first leg starts, immediately when a demo endpoint changes live data, and on the tick the departure comes due. Alerts: `plan`, `order_changed`, `leave_earlier`, `leave_later` (including a one-time "Hold on" when the departure is pushed back just as it comes due), then `leave_now` for each leg. Re-plans start at `depart_after` (or now); if that comes out late while `depart_after` is still ahead, they try starting about as much earlier as it's late (up to 3 times, never before now) and keep the least late, so you get `leave_earlier` instead of a plan that quietly goes late. A plan is marked done after the last arrival. A plan you never started whose windows have all closed, and whose planned departure has passed, gets one `info` "Missed" alert instead. Re-plans keep the current stop order unless another is clearly better (on lateness, or by 3+ min), so the order doesn't flip-flop.
5. Watched roads (`POST /slowdowns/{id}/watch`) are checked on every tick and send one `cleared` alert ("I-45 Gulf Fwy has cleared") when their cause is gone. See [Why it's slow](#why-its-slow).
6. The frontend polls `/notifications`, shows toasts, and uses web push when available.

## Data model (SQLite via SQLAlchemy)

- `Node`: id, name, lat, lng, is_place
- `RoadSegment`: id, name, highway, road_class (`freeway`/`arterial`), direction, from_node, to_node, length_m, free_flow_mph, geometry (JSON list of `[lat, lng]`: the real road, traced from OpenStreetMap by `scripts/fetch_road_shapes.py` into `app/seed/road_shapes.json`; existing databases pick up new shapes on startup)
- `RailCrossing`: id, name, lat, lng, rail_line, segment_id
- `Camera`: id, kind (`highway`/`train`), name, lat, lng, url, segment_id, crossing_id
- `ScoreEntry`: model, entity_id, bucket, value, aux, n_obs (aux = avg blocked minutes for trains)
- `Trip`: id, name, origin, destination, arrive_by (HH:MM), days (e.g. `0,1,2,3,4`), safe_path, safety_weight, device_id
- `TripState`: trip_id, day, last_departure, last_route, leave_now_sent
- `SavedPlan`: id, name, device_id, request_json, result_json (the `plan_result.json` shape), watch, announced, leave_now_sent (leg indexes), held ("Hold on" sent), done, created_at, last_planned_at
- `SlowdownWatch`: id, segment_id, device_id, created_at (sim time), routine_only (nothing unusual when watched), done
- `Notification`: id, trip_id or plan_id, created_at (sim time), title, body, kind (`plan`, `leave_now`, `leave_earlier`, `leave_later`, `reroute`, `order_changed`, `cleared`, `info`)

## Folder layout

```
backend/
  app/
    main.py            FastAPI app + lifespan (scheduler loop)
    config.py          settings (env vars)
    db.py              engine, session, Base
    models.py          SQLAlchemy models
    clock.py           simulated clock
    timebuckets.py     bucket helpers
    timeutil.py        Houston time zone helpers
    adapters/          DataSource interfaces + mocks
    conditions/        live records + road-conditions layer (priority rules)
    scoring/           store + three models + replay
    routing/           graph + router
    recommender.py     single-trip departure time
    planner.py         multi-stop plans
    plan_io.py         plan request/result JSON (docs/contracts shapes)
    causes.py          why it's slow: delay split into causes, slowdowns, speed history
    demo_scenarios.py  canned live data for the demo (Monday 5 PM "evening")
    notifications/     service + scheduler
    api/               routers
    seed/              Houston network + synthetic generator
  scripts/             seed.py, replay_history.py
  tests/
frontend/
  app/                 Next.js entry, fonts, theme (globals.css), PWA manifest
  components/app/      AppContext (data polling, screen navigation, map scene), AppShell, map chrome, demo
  components/map/      the Leaflet traffic map
  components/screens/  WhereTo, Trip, LiveMap, Causes, WhySlow, Alerts, Cameras
  components/ui/       shared pieces in the design's style (icons, chips, pills, buttons, logo)
  lib/                 API client, types, theme tokens, formatting
Makefile               setup / seed / dev / test
```

## Plugging in real data

Each interface in `backend/app/adapters/base.py` corresponds to a real feed. See the README section "How real data plugs in", and [docs/routing-wiring.md](docs/routing-wiring.md) for which routing decision uses which method and what happens when it's missing.
