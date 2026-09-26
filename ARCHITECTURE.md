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
| Departure recommender | `backend/app/recommender.py` | Tries departures every 5 minutes and picks the latest one that still arrives on time. Also returns a `leave_at_safe` with a margin that grows as confidence drops. |
| Multi-stop planner | `backend/app/planner.py`, `plan_io.py` | Up to 3 stops with time windows, dwell and fixed-order stops. Picks the stop order and every departure time, and compares the result against a leave-now baseline in the typed order. |
| Notifications | `backend/app/notifications/` | `NotificationService` interface (mock = stored in DB, WebPush = stub) + a scheduler that re-checks saved trips and watched plans on each clock tick. |
| Simulated clock | `backend/app/clock.py` | The whole app reads "now" from here. It runs at `CLOCK_SPEED` × real time from `SIM_START` (a Monday 7:15 AM), and the demo can jump it. |
| Services | `backend/app/services.py` | Wires network + models + router + scheduler + clock together for the API. |
| REST API | `backend/app/api/` | FastAPI routers. |
| Frontend | `frontend/` | Next.js PWA with a Leaflet map, trip panel, time slider, notification drawer and demo mode. |

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
| Incident | A closure shuts the road until it clears (the router waits or goes around). Crash ×1.6, roadwork ×1.3, stall or hazard ×1.2, +0.25 per extra lane, max ×3, until it clears (default 45 min) |
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
- a **traffic-only route** (congestion-aware but blind to trains and crash risk, roughly what a typical nav app picks). Hazards on it that the chosen route skips become "Avoided X: 72% chance of a train around 7:38 AM".
- when live data is in play, the route it *would* have picked on predictions alone. Roads it skips because of live data become "Rerouted around X: crash reported (demo feed, just now)" or "heavier traffic than usual right now (traffic camera, 2 min ago)".
- when a feed is down, a first bullet saying the route is running on predictions.

## Request flow

1. The user saves a trip: origin, destination, arrive-by time, days of week, safety weight.
2. `recommend_departure` tries departures from `arrive_by - 2h` to `arrive_by` in 5-minute steps, routes each one, and picks the latest one where `eta + buffer <= arrive_by`.
3. The scheduler runs on every clock tick (a background loop every 30 s, plus every `/demo/advance-clock`), starting 3 h before a trip's arrive-by time. It sends:
   - `plan` on the first check of the day ("leave at 7:35 AM via ...")
   - `leave_earlier` if the recommended departure moved ≥5 minutes earlier
   - `leave_later` if it moved ≥10 minutes later
   - `reroute` if the departure time held but the route changed (e.g. a live train)
   - `leave_now` once, when `now >= departure`
4. Watched multi-stop plans (`POST /plan` with `watch: true`) are re-planned every 5 min until the first leg starts, immediately when a demo endpoint changes live data, and on the tick the departure comes due. Alerts: `plan`, `order_changed`, `leave_earlier`, `leave_later` (including a one-time "Hold on" when the departure is pushed back just as it comes due), then `leave_now` for each leg. A plan is marked done after the last arrival. A plan you never started whose windows have all closed gets one `info` "Missed" alert instead.
5. The frontend polls `/notifications`, shows toasts, and uses web push when available.

## Data model (SQLite via SQLAlchemy)

- `Node`: id, name, lat, lng, is_place
- `RoadSegment`: id, name, highway, road_class (`freeway`/`arterial`), direction, from_node, to_node, length_m, free_flow_mph, geometry (JSON list of `[lat, lng]`)
- `RailCrossing`: id, name, lat, lng, rail_line, segment_id
- `Camera`: id, kind (`highway`/`train`), name, lat, lng, url, segment_id, crossing_id
- `ScoreEntry`: model, entity_id, bucket, value, aux, n_obs (aux = avg blocked minutes for trains)
- `Trip`: id, name, origin, destination, arrive_by (HH:MM), days (e.g. `0,1,2,3,4`), safe_path, safety_weight, device_id
- `TripState`: trip_id, day, last_departure, last_route, leave_now_sent
- `SavedPlan`: id, name, device_id, request_json, result_json (the `plan_result.json` shape), watch, announced, leave_now_sent (leg indexes), done, created_at, last_planned_at
- `Notification`: id, trip_id or plan_id, created_at (sim time), title, body, kind

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
    notifications/     service + scheduler
    api/               routers
    seed/              Houston network + synthetic generator
  scripts/             seed.py, replay_history.py
  tests/
frontend/              Next.js app
Makefile               setup / seed / dev / test
```

## Plugging in real data

Each interface in `backend/app/adapters/base.py` corresponds to a real feed. See the README section "How real data plugs in", and [docs/routing-wiring.md](docs/routing-wiring.md) for which routing decision uses which method and what happens when it's missing.
