# Architecture

Houston Traffic App tells commuters **when to leave and which way to go** before traffic hits. It predicts congestion, crash risk and freight-train crossing blockages from historical data, instead of only reacting to live jams.

Hackathon-sized: one Python backend, one Next.js frontend, one SQLite file. Every external feed sits behind an interface with a synthetic **mock** implementation, so the app runs end to end with no API keys.

```
                +-------------------------- backend (FastAPI) ---------------------------+
                |                                                                        |
 DataSources -->|  adapters/        scoring/                 routing/        recommender |
 (mock today,   |  SpeedSource  --> CongestionModel  --+                                 |
  TranStar /    |  CrashSource  --> CrashRiskModel   --+--> Router ------> recommend_    |
  TrainWatch    |  TrainSource  --> TrainBlockModel  --+   (time-dep.      departure()   |
  later)        |  CameraSource                      |     Dijkstra)          |          |
                |                    ScoreStore (EMA, SQLite)                 v          |
                |                                                  notifications/        |
                |                                                  scheduler + service   |
                |                         api/ (REST, OpenAPI at /docs)                  |
                +--------------------------------------+---------------------------------+
                                                       |
                                           frontend (Next.js PWA + Leaflet)
```

## Components

| Component | Where | Job |
|---|---|---|
| Data-source adapters | `backend/app/adapters/` | Abstract interfaces (`SpeedSource`, `CrashSource`, `TrainSource`, `CameraSource`) + `Mock*` implementations built on the synthetic generator. Picked by `DATA_SOURCE` config (`mock` only for now). |
| Scoring models | `backend/app/scoring/` | Three models with the same shape: key = (entity, time bucket), value updated by an exponential moving average. |
| Score store | `backend/app/scoring/store.py` | Persists scores in the `score_entries` table and caches them in memory for fast routing. |
| Routing engine | `backend/app/routing/` | Time-dependent Dijkstra over the road graph with a blended cost and a Safe Path toggle. |
| Departure recommender | `backend/app/recommender.py` | Tries departures every 5 minutes and picks the latest one that still arrives on time. |
| Notifications | `backend/app/notifications/` | `NotificationService` interface (mock = stored in DB, WebPush = stub) + a scheduler that re-checks saved trips on each clock tick. |
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

**Live overrides:** a crossing that is blocked *right now* (reported by the train source, or injected with `/demo/block-crossing`) replaces the prediction with the actual remaining blockage time while it lasts.

## Routing

The graph has nodes (interchanges and places) and directed `RoadSegment` edges. Some segments carry `RailCrossing`s. For a departure time `t` the router accumulates the arrival time at each segment and scores each edge as:

```
edge_cost = travel_time(seg, t_seg)                     # from congestion score
          + sum(expected_delay(crossing, t_crossing))    # train model (or live block)
          + lambda_crash * crash_risk(seg, t_seg) * seg_miles
lambda_crash = 30 s/mile normally, 600 s/mile with safe_path=True
```

It returns the best route, one alternative (found by penalizing edges of the best route), a breakdown (base travel, train delay, crash exposure) and human-readable "why" reasons. To explain its choice, it also computes:
- a **traffic-only route** (congestion-aware but blind to trains and crash risk, roughly what a typical nav app picks). Hazards on it that the chosen route skips become "Avoided X: 72% chance of a train around 7:38 AM".
- when a crossing is blocked live, the route it *would* have picked without the blockage, which becomes "Rerouted around X: blocked by a train right now".

## Request flow

1. The user saves a trip: origin, destination, arrive-by time, days of week, Safe Path preference.
2. `recommend_departure` tries departures from `arrive_by - 2h` to `arrive_by` in 5-minute steps, routes each one, and picks the latest one where `eta + buffer <= arrive_by`.
3. The scheduler runs on every clock tick (a background loop every 30 s, plus every `/demo/advance-clock`), starting 3 h before a trip's arrive-by time. It sends:
   - `plan` on the first check of the day ("leave at 7:35 AM via ...")
   - `leave_earlier` if the recommended departure moved ≥5 minutes earlier
   - `leave_later` if it moved ≥10 minutes later
   - `reroute` if the departure time held but the route changed (e.g. a live train)
   - `leave_now` once, when `now >= departure`
4. The frontend polls `/notifications`, shows toasts, and uses web push when available.

## Data model (SQLite via SQLAlchemy)

- `Node`: id, name, lat, lng, is_place
- `RoadSegment`: id, name, highway, road_class (`freeway`/`arterial`), direction, from_node, to_node, length_m, free_flow_mph, geometry (JSON list of `[lat, lng]`)
- `RailCrossing`: id, name, lat, lng, rail_line, segment_id
- `Camera`: id, kind (`highway`/`train`), name, lat, lng, url, segment_id, crossing_id
- `ScoreEntry`: model, entity_id, bucket, value, aux, n_obs (aux = avg blocked minutes for trains)
- `Trip`: id, name, origin, destination, arrive_by (HH:MM), days (e.g. `0,1,2,3,4`), safe_path, device_id
- `TripState`: trip_id, day, last_departure, last_route, leave_now_sent
- `Notification`: id, trip_id, created_at (sim time), title, body, kind

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
    adapters/          DataSource interfaces + mocks
    scoring/           store + three models + replay
    routing/           graph + router
    recommender.py
    notifications/     service + scheduler
    api/               routers
    seed/              Houston network + synthetic generator
  scripts/             seed.py, replay_history.py
  tests/
frontend/              Next.js app
Makefile               setup / seed / dev / test
```

## Plugging in real data

Each interface in `backend/app/adapters/base.py` corresponds to a real feed. See the README section "How real data plugs in".
