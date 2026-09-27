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
| Vision Zero HIN | `backend/app/seed/visionzero.py`, `api/hazards.py` | Real city crash data: scales each street's synthetic crash rate, and serves the most dangerous streets at `GET /hazards/high-injury`. |
| Scoring models | `backend/app/scoring/` | Three models with the same shape: key = (entity, time bucket), value updated by an exponential moving average. |
| Score store | `backend/app/scoring/store.py` | Persists scores in the `score_entries` table and caches them in memory for fast routing. |
| Routing engine | `backend/app/routing/` | Time-dependent Dijkstra-style search over the road graph with a blended cost and a 0-1 safety weight (the Faster ↔ Safer slider). It keeps several labels per node (time so far vs. penalty so far), because once roads can be waited on, reaching one later can be the better choice. |
| Causes engine | `backend/app/causes.py`, `api/causes.py` | "Why is it slow?" Splits every road's delay into causes (rush hour, busier than usual, crash, construction, closure, event, weather, train) and powers the map's cause icons, the "Why it's slow" screen, traffic alerts and "notify me when it clears". See [Why it's slow](#why-its-slow). |
| Live AI camera feeds | `backend/app/cv/`, `api/cv.py` | Bridge to the team's computer-vision app (blindspot-cv, its own process, `CV_URL`): follows its live stream, keeps each camera's recent frames, vehicle boxes and incident check, serves the video as MJPEG, and turns camera-confirmed incidents into live incidents on our roads. See [Live AI camera feeds](#live-ai-camera-feeds). |
| Departure recommender | `backend/app/recommender.py` | Tries departures every 5 minutes and picks the latest one that still arrives on time. Also returns a `leave_at_safe` with a margin that grows as confidence drops. |
| Multi-stop planner | `backend/app/planner.py`, `plan_io.py` | Up to 3 stops with time windows, dwell and fixed-order stops. Picks the stop order and every departure time, and compares the result against a leave-now baseline in the typed order. |
| Notifications | `backend/app/notifications/` | `NotificationService` interface (mock = stored in DB, WebPush = stub) + a scheduler that re-checks saved trips and watched plans on each clock tick. |
| Simulated clock | `backend/app/clock.py` | The whole app reads "now" from here. It runs at `CLOCK_SPEED` × real time from `SIM_START` (a Monday 7:15 AM), and the demo can jump it. |
| Services | `backend/app/services.py` | Wires network + models + router + scheduler + clock together for the API. |
| REST API | `backend/app/api/` | FastAPI routers. |
| Places | `backend/app/geo/`, `api/geo.py`, `frontend/components/places/` | Real places from OpenStreetMap: address and business search, place details and opening hours (through Nominatim), saved places, and gas / EV / parking from the street map's tiles. See [Places](#places). |
| Frontend | `frontend/` | Next.js PWA, dark theme. One Leaflet map (over a free MapLibre vector street map from OpenFreeMap) stays mounted under every screen: Where to, Trip, Live map, Causes, Why it's slow, Alerts, Live cams and Nearby. Full-screen panels on a phone (Trip and Nearby: a sheet over the map), a 420px side panel next to the map on desktop. Live cams plays the camera AI's real video with its vehicle boxes when a camera has a live feed. Plus the scripted demo. |

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

**Street crash risk is calibrated to Vision Zero.** The synthetic crash history isn't uniform: each street link's crash rate is scaled by the City of Houston's Vision Zero High Injury Network 2025 (`app/seed/visionzero.py`, data in `seed/hin2025.json`). A link matches the HIN segments with the same street name whose midpoint is within 400 m (half a HIN segment) of its real road shape; the name keeps cross streets and the same street across town out. Its factor is `1 + HIN crashes per mile / the citywide HIN average`, max ×4. Streets not on the HIN get ×1, freeways keep their hand-set `crash_mult` (the HIN has no freeways). The factor goes into the generator's ground truth, not the model's prior: the EMA forgets its starting value within a few weeks of replay, and a real crash feed (TxDOT CRIS) would plug in at the same place. `GET /hazards/high-injury` serves the raw HIN segments, worst first.

**Live data** doesn't go into the models. It goes into the road-conditions layer, which blends it with the predictions for about the next 30 minutes:

| Input | Rule |
|---|---|
| Crossing reported blocked | Wait until it clears. Confidence high, or low if the sensor is down (still used) |
| Crossing reported clear, sensor up | No wait if you arrive within 5 min. After that, back to the prediction |
| Crossing sensor down or status older than 15 min | Prediction, low confidence |
| Live congestion reading | Only while fresh (10 min freeway, 30 min street). Blend weight `0.8 × (1 − minutes_ahead/30) × confidence factor` |
| Incident | A closure shuts the road until it clears (the router waits or goes around). Crash ×1.6, lane closure ×1.5, weather ×1.35, roadwork or event ×1.3, stall, hazard or other ×1.2, +0.25 per extra lane, max ×3, until it clears (default 45 min) |
| Camera-confirmed incident | The same as an incident (one lane, kind read from the model's description), on the camera's road, while the camera AI keeps it confirmed; possible (unconfirmed) ones are ignored. Never marks a feed down |
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

## Places

Search, place cards, saved places and nearby gas / EV / parking. Everything is OpenStreetMap data, free and keyless; nothing is made up when a service is down.

- **Search** (`GET /geocode?q=&lat=&lng=`): the backend asks Nominatim (`app/geo/nominatim.py`) for up to 15 matches in a box about 5 km around you, and the whole Houston area (Katy to Baytown, The Woodlands to Galveston Bay, bounded) when that finds fewer than 3 (or when you're outside that area: the search never leaves Houston). Near you, a chain's branches all rank the same, so results are sorted by distance, with well-known places (Nominatim importance ≥ 0.1: a university, the airport) on top. Each result is a name, a short address line ("3407 Montrose Boulevard, Montrose"), the point and a kind ("Cafe", "Gas station", "Address"). The app shows our own named places first and opens the Trip to the point (the router snaps it to the nearest road-map node).
- **Nominatim's rules:** one request per second for the whole app (a shared limiter; a request that would wait more than 4 s gets "busy"), a User-Agent that says who we are, 6 s timeouts, and caching. Nominatim's raw answers are cached in memory (LRU) and in the `geo_cache` table: searches for a day, places for a week, "nothing found" for an hour. When Nominatim fails, an expired cached answer comes back marked `stale` (for a spot with nothing cached, the whole area's cached answer, without asking again); with none, the API answers 503 and the app says "Search is down right now" (our own places keep working). The frontend waits 350 ms after typing stops, needs 3 letters and keeps one request in flight (the latest query goes next). `NOMINATIM_URL` points at another server.
- **Details** (`GET /geocode/details?osm=W123` or `?name=&lat=&lng=`): the OpenStreetMap tags of a place: phone (with a `tel:` form), website (http/https only), brand, cuisine, and `hours`. Search results carry the same tags, so a result's details are cached with it. A map dot's OpenStreetMap id comes from the vector tile: feature id = OSM id × 10 + 1 (node), 2 (way) or 3 (relation).
- **Opening hours** (`app/geo/hours.py`) reads the `opening_hours` tag: `24/7` (alone or as one rule), weekday lists and ranges (`Mo-Fr`, `Fr-Mo`, `Mo,We`), several spans a day, spans past midnight (`18:00-02:00`), `off`, later rules replacing earlier ones, holiday rules skipped. It works out the status at the app's clock in Houston time (or at `at`, e.g. when you'd arrive): "Open now, closes 9 PM", "Closing soon, at 9 PM" (within an hour), "Closed, opens 7 AM tomorrow", "Open 24 hours", plus the week's hours. Anything fancier (months, sunrise, comments, week numbers) gives `open: null` and the card shows the raw text.
- **Place card** (`PlaceCard.tsx`): one card for map dots, search results, saved places and the nearby list: kind, name, address, hours, phone, website, a star, "Save as Home / Work" and Directions. A popup on desktop, a sheet at the bottom on a phone. On the Trip it also warns when the place is closed, or closes within 20 min, at the arrival time.
- **Saved places** (`store.ts`): Home, Work and up to 20 favorites in `localStorage` (`blindspot.saved`), read and written inside try/catch so a private window just doesn't remember. Chips on Where to (Home / Work with their drive time), an editor, and markers on the map (a star for favorites).
- **Gas / EV / parking** (`pois.ts`, `poiLayers.ts`): OpenFreeMap's OpenMapTiles `poi` layer has gas stations (class `fuel`), EV chargers (class `fuel`, subclass `charging_station`) and parking (class `parking`), but only in the zoom-14 tiles. The app fetches and decodes those tiles itself (`@mapbox/vector-tile`, the same files the map loads when you zoom in, cached by the browser): into a GeoJSON source for the map highlights (from Leaflet zoom 13, up to 120 tiles in view), and for the lists: **near you** (the tiles within ~2 km, then ~4 km; closest first as the crow flies) and **along a route** (the tiles the route passes; places within 800 m of it, the closest to the road in each stretch so they spread along the trip, in the order you pass them). No prices or live availability: OpenStreetMap doesn't have them.

## Live AI camera feeds

The CV app (blindspot-cv, [its README](https://github.com/qian-json/blindspot-cv)) runs its own detector and incident check and streams everything as Server-Sent Events on `GET <CV_URL>/live`: `{"updates": [{cam, kind: raw | yolo | incident, jpeg (base64) | null, info}]}`. `raw` is a video frame (~8-10 a second), `yolo` the vehicle boxes for a frame (`[x1, y1, x2, y2 as fractions, class, confidence, mph]`, plus counts and 60 s rolling numbers), `incident` the latest check (`p`, `state` confirmed / possible / clear, the model's `text`). Its page (`GET /`) names the cameras and says whether the incident check is on; `POST /view?mode=one&cam=br:<id>` picks the camera it processes.

```
 blindspot-cv (Mac, or here)                      backend (app/cv/)                               frontend (Live cams)
  Baton Rouge HLS -> detector ---- /live SSE ---->  CvBridge thread: frames (8 s), boxes    <- poll -- GET /cv/cameras/{id} (boxes, counts,
                  -> incident check                 (12 s), status, IncidentWatch           ------->  flow, incident); watching = touch
                  <-- POST /view (CV_VIEW) ------   control thread: view, incident changes  -- MJPEG -> <img>, 2.5 s behind, boxes drawn on top
                                                    CameraAiIncidents --> ConditionsProvider --> router, causes, alerts, /live
```

- **Bridge** (`cv/bridge.py`, `CvBridge`): one daemon thread follows the stream (5 s connect / 30 s read timeouts, reconnects with 1-30 s backoff, never raises into the API; an update it can't read, e.g. NaN or Infinity numbers, is skipped on its own); another switches the CV app's view and notices when the confirmed incidents change (then the scheduler re-plans watched trips). All state sits behind one lock with no I/O under it, and it's bounded: 8 s of frames for mapped cameras only (at most 120), 12 s of box sets, 32 cameras. The API only reads it.
- **Mapping** (`CV_CAMERAS`, `"007=cam_I45S_downtown_gulf_ee,009=cam_I10W_downtown_i10_610w"`): each CV camera stands in for one of ours. Unknown ids and duplicates are reported in `/cv/status` and dropped; a mapped camera the CV app doesn't run is `missing`.
- **Status per camera**: `live` (frames in the last 10 s), `connecting` (starting, or being switched to), `paused` (the CV app is on another camera), `missing`, `offline` (can't reach the CV app).
- **Boxes on the right cars.** The detector runs about once a second and its boxes arrive ~(inference time + 80 ms) after their frame, so the bridge pairs each box set with the buffered frame closest to that moment (on the live stream: the exact frame or its neighbour). The MJPEG stream plays `CV_VIDEO_DELAY_S` (2.5 s) behind, and each box set carries its frame's time on the server clock, so the card knows which boxes belong to the frame on screen and moves each vehicle's box between two box sets (matched by position and size, the rest fade), so they follow the cars between detections.
- **Which camera runs** (`CV_VIEW`): `follow` (default) posts `/view` for the camera someone is watching (polling its state or holding its video counts as watching for 20 s), else the first mapped camera, at most every 2 s. Two cameras watched at once (both cards still asking in the last 3 s) take turns of 30 s, since switching every 2 s would never let either video start. `all` sets mode=all once; `off` leaves it alone.
- **Incidents** (`IncidentWatch`, `cv/incidents.py`): a confirmed check starts an episode and gives it its description (kept for the episode: the model words each check afresh, and a new wording every few seconds would re-plan trips and could flip crash to stall); possible checks keep it going; it ends once the camera has seen a clear road for `CV_CLEAR_AFTER_S` (120 s), or 10 min after its last check (the camera was switched off or the CV app went away). While it's on, `CameraAiIncidents.active(now)` returns it as an `Incident` on the camera's segment, source `camera_ai` ("camera AI"), title by kind ("Crash spotted by camera AI"; crash, stall, hazard or other, from the model's words), the model's description in `detail` with the stand-in note. It happened in real time, so its times are "that long ago" on the simulated clock too. `ConditionsProvider.collect` adds these to the incident feed's, so routing, causes, alerts and `/live` treat them like any incident; if they fail, they're skipped and no feed is marked down.
- **Endpoints** (`api/cv.py`): `/cv/status`, `/cv/cameras/{id}`, `/cv/cameras/{id}/video` (MJPEG, 503 when not live or when 16 videos are already open, ends when the feed stops or after 30 min; open streams end when the server is told to stop so uvicorn doesn't wait on them), `/cv/cameras/{id}/frame.jpg`. `/cameras` and `/live` carry a `live_feed` summary per camera (`null` without one); the contract fields (`vehicles`, ...) stay Houston-only.
- **Fake CV server** (`scripts/fake_cv.py`, `make cv-fake`): the same `/`, `/live` and `/view`, replaying 57 recorded Baton Rouge frames with their real boxes (`scripts/fake_cv_frames/`), boxes sent 0.3 s after their frame like a real detector, and a scripted incident on `POST /incident`. Its page says it's a test server, and the card says the video is a recording and the incident scripted.

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
- `GeoCache`: key (`search|<query>|<area>`, `place|W123`, `find|<name>|<point>`), value (Nominatim's raw rows), fetched_at (real UTC time)

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
    geo/               place search and details (Nominatim client, cache, rate limit), opening hours
    cv/                live AI camera feeds: bridge to the CV app, camera-confirmed incidents
    notifications/     service + scheduler
    api/               routers
    seed/              Houston network + synthetic generator + Vision Zero HIN data (visionzero.py)
  scripts/             seed.py, replay_history.py, fetch_road_shapes.py, fake_cv.py (+ fake_cv_frames/)
  tests/
frontend/
  app/                 Next.js entry, fonts, theme (globals.css), PWA manifest
  components/app/      AppContext (data polling, screen navigation, map scene), AppShell, map chrome, demo
  components/map/      the Leaflet traffic map
  components/places/   place card, search, saved places, nearby gas / EV / parking (list, map highlights)
  components/screens/  WhereTo, Trip, LiveMap, Causes, WhySlow, Alerts, Cameras
  components/ui/       shared pieces in the design's style (icons, chips, pills, buttons, logo)
  lib/                 API client, types, theme tokens, formatting
Makefile               setup / seed / dev / test
```

## Plugging in real data

Each interface in `backend/app/adapters/base.py` corresponds to a real feed. See the README section "How real data plugs in", and [docs/routing-wiring.md](docs/routing-wiring.md) for which routing decision uses which method and what happens when it's missing.
