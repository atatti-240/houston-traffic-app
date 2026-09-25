# Claude Code Build Prompts: Houston Traffic App

Paste these into Claude Code **in order**, one per turn. Each one builds on the last. Start a fresh session only if context gets heavy. Every prompt tells Claude Code to read `ARCHITECTURE.md` first, so each one stands alone.

**Stack assumption:** Python FastAPI + SQLite (SQLAlchemy) backend, Next.js PWA frontend with Leaflet. If your team knows something else, change it in Prompt 1 and the rest will follow `ARCHITECTURE.md`.

**Ground rule for every prompt:** no real APIs, no API keys, no computer vision. Every data source goes behind an interface and ships with a mock/synthetic version.

---

## Prompt 1: Architecture + repo skeleton

```
We're at a 48-hour hackathon building a Houston traffic app. Mission: tell Houston
commuters when to leave and which way to go BEFORE traffic hits, by predicting
congestion, crash risk, and freight-train crossing blockages from historical +
live data (Houston TranStar, TrainWatch-style train data, Bluetooth speed sensors).

Read _bmad-output/planning-artifacts/briefs/brief-houston-traffic-app-2026-09-25/brief.md for the full brief.

Write ARCHITECTURE.md at the repo root, then scaffold the repo to match it. Keep it
hackathon-sized: one backend service, one frontend, SQLite. Cover:

1. Components: data-source adapters, scoring models (congestion, crash risk, train
   blockage), routing engine, departure-time recommender, notification service,
   REST API, web frontend (Next.js PWA + Leaflet map).
2. A DataSource interface layer. Every external feed (TranStar speeds/travel
   times, TranStar incidents, TranStar camera list, train positions/crossing
   events, Bluetooth sensor speeds) gets an abstract interface + a Mock
   implementation that reads synthetic data. Real implementations come later and
   must be swappable via config only.
3. Data model (entities + key fields): RoadSegment, Intersection/Node,
   RailCrossing, TimeBucket (15-min slot x day-of-week), CongestionScore,
   CrashRiskScore, CrossingBlockScore, Camera, Trip, User/Device (for push).
4. How a request flows: user trip + arrive-by time -> candidate departure times ->
   routes per departure -> blended cost -> recommendation -> notification.
5. Folder layout: /backend (FastAPI app, models, scoring, routing, adapters, tests),
   /frontend (Next.js), /data (synthetic seeds), /scripts.

Then scaffold: FastAPI app with a /health endpoint, SQLAlchemy setup, pytest
configured, Next.js app with a blank Leaflet map centered on downtown Houston,
a Makefile or README with one-command run for each. Don't implement the models
yet. Commit when done.
```

---

## Prompt 2: Road network database + synthetic seed data

```
Read ARCHITECTURE.md first.

Build the road network and seed data layer in /backend:

1. SQLAlchemy models + migration/create-all for RoadSegment (id, name, highway,
   direction, start/end node, length_m, free_flow_speed_mph, geometry as a list of
   lat/lng), Node, RailCrossing (id, name, lat/lng, rail line, segment_id it sits on),
   Camera (id, type: highway|train, lat/lng, url, segment_id or crossing_id).
2. A seed script (scripts/seed.py) that builds a small but realistic Houston
   graph: approximate segments for I-45, I-10, I-610 Loop, I-69/US-59, Beltway 8,
   SH-288, US-290, plus a few surface-street alternates so there's more than one
   route between major points (downtown, Galleria, Medical Center, Energy Corridor,
   Greenspoint, East End). Use approximate real lat/lngs. Add ~10 at-grade rail
   crossings on the surface-street alternates (East End / Near Northside area).
   Add placeholder camera records with fake URLs.
3. A synthetic history generator: 8 weeks of per-segment speed observations per
   15-min bucket with realistic rush-hour patterns (AM inbound, PM outbound),
   random incidents, and weekend differences. Also synthetic train crossing
   events (blocked start/end times) with a few crossings having recurring
   blockage windows, and synthetic crash records clustered on a few segments.
   Make it deterministic with a seed.

Write tests that the graph is connected and that at least 2 distinct routes
exist between downtown and the Galleria. Commit when done.
```

---

## Prompt 3: Congestion Score model

```
Read ARCHITECTURE.md first.

Implement the Congestion Score model in /backend/scoring/congestion.py:

- Key: (segment_id, time_bucket) where time_bucket = (day_of_week, 15-min slot).
- Daily observation for a bucket = congestion ratio = 1 - (observed_speed / free_flow_speed),
  clamped to [0, 1].
- Update rule is an exponential moving average, NOT additive:
    score = score + alpha * (today_observation - score)
  alpha (the "nudge factor") is configurable, default 0.2.
- First observation initializes the score directly.
- Functions: update_from_observations(date, observations), get_score(segment_id,
  datetime) -> float, get_segment_travel_time(segment_id, datetime) -> seconds
  (derived from free-flow time scaled by score).
- A replay script (scripts/replay_history.py) that feeds the 8 weeks of synthetic
  history day-by-day through the model and stores the resulting scores.

Unit tests: EMA converges toward a stable input, reacts to a sustained change,
stays in [0,1], and a rush-hour bucket ends up higher than a 3am bucket on I-45
after replay. Commit when done.
```

---

## Prompt 4: Crash risk + train blockage models

```
Read ARCHITECTURE.md and backend/scoring/congestion.py first. Reuse the same
(key, time_bucket) + EMA pattern so all three models look alike.

1. /backend/scoring/crash_risk.py: per (segment_id, time_bucket) crash risk score.
   Observation = crashes in that bucket that day normalized per mile of segment.
   Use EMA plus a small prior so segments with zero history aren't exactly 0.
   Expose get_crash_risk(segment_id, datetime) in [0,1] and a method to list the
   top N riskiest segments for a given time.
2. /backend/scoring/train_block.py: per (crossing_id, time_bucket) probability the
   crossing is blocked, plus expected delay in seconds if blocked. Observation = was
   it blocked at any point in the bucket (0/1) and blocked duration. EMA both.
   Expose get_block_probability(crossing_id, datetime) and
   get_expected_delay(crossing_id, datetime) = probability * avg_blocked_duration.
3. Extend replay_history.py to update all three models.

Unit tests for both, including: a crossing with recurring 7:30-7:45am blockages
ends up with high probability in that bucket and low probability at noon.
Commit when done.
```

---

## Prompt 5: Routing engine + Safe Path

```
Read ARCHITECTURE.md and the three scoring modules first.

Build /backend/routing/:

- Load the road graph from the DB into networkx (or a simple Dijkstra/A* if you
  prefer, no heavy deps).
- Edge cost for departure time t:
    cost = predicted_travel_time(segment, t_at_segment)
         + sum(expected_train_delay for crossings on the segment at t_at_segment)
         + lambda_crash * crash_risk(segment, t_at_segment) * segment_length_penalty
  t_at_segment is the estimated time you reach that segment (time-dependent
  routing: accumulate travel time along the path).
- lambda_crash default is small; "safe_path=True" raises it sharply so the route
  avoids crash-prone highway segments even at some time cost.
- route(origin, destination, depart_at, safe_path=False) returns ordered segments,
  geometry, total ETA, and a breakdown: base travel time, train delay, crash risk
  exposure, plus a list of "why" reasons (e.g. "Avoided Navigation Blvd crossing:
  72% chance of train at 7:40").
- Return the best route and one alternative.

Tests: safe_path changes the chosen route on at least one seeded origin/destination
pair; a route avoids a crossing during its high-blockage window but uses it at noon.
Commit when done.
```

---

## Prompt 6: Departure-time recommender + notifications

```
Read ARCHITECTURE.md and backend/routing first.

1. /backend/recommender.py: recommend_departure(origin, destination, arrive_by,
   safe_path, buffer_min=5). Try departure times every 5 minutes in a window
   (e.g. arrive_by - 2h to arrive_by), route each, and pick the LATEST departure
   whose predicted arrival + buffer <= arrive_by. Return departure time, route,
   ETA, and confidence (lower when train/crash risk on the route is high).
2. /backend/notifications/: a NotificationService interface with a Mock
   implementation that logs + stores notifications, and a WebPush implementation
   stub (no keys; leave TODOs). A scheduler (APScheduler) that, for saved trips,
   re-runs the recommendation periodically and fires a "Leave now" notification
   at the recommended time, or an "Leave 10 min earlier: train likely at X" update
   if the recommendation shifts.
3. Trip model: saved commute (origin, destination, arrive_by, days of week,
   safe_path preference).

Tests: recommender picks a later departure at 5am than at 7am for the same
arrive-by offset; notification fires when simulated clock hits departure time.
Commit when done.
```

---

## Prompt 7: REST API

```
Read ARCHITECTURE.md first. Expose the backend over FastAPI with OpenAPI docs:

- GET  /segments                       -> segments with geometry
- GET  /scores/congestion?at=ISO       -> score per segment at that time
- GET  /scores/crash-risk?at=ISO       -> risk per segment
- GET  /crossings?at=ISO               -> crossings + block probability + expected delay
- GET  /cameras                        -> highway + train camera list
- POST /route                          -> {origin, destination, depart_at, safe_path}
- POST /recommend                      -> {origin, destination, arrive_by, safe_path}
- POST /trips, GET /trips              -> saved commutes
- GET  /notifications                  -> recent notifications (mock channel)
- POST /demo/advance-clock             -> move simulated time forward (for the live demo)
- POST /demo/replay                    -> re-run history replay

Origins/destinations can be lat/lng (snap to nearest node) or one of the named
places from the seed (downtown, Galleria, etc.). Add CORS for the frontend.
API tests for each endpoint. Commit when done.
```

---

## Prompt 8: Frontend

```
Read ARCHITECTURE.md and the API (backend OpenAPI) first.

Build the Next.js PWA frontend:

1. Full-screen Leaflet map of Houston. Layers (toggleable): congestion heatmap on
   segments (green->red by score), crash-risk segments (hatched/outlined),
   rail crossings (icon colored by block probability), cameras (click opens the
   camera URL in a panel).
2. Trip panel: pick origin/destination (named places dropdown + click-on-map),
   arrive-by time, Safe Path toggle, "Plan" button. Show recommended departure time
   big and bold, the route on the map, the alternative route dimmed, and the "why"
   reasons list.
3. Time slider to scrub the map through a day so judges can watch rush hour build.
4. Notifications drawer showing the mock "Leave now" alerts; register the service
   worker for web push but fall back to in-app toasts.
5. Mobile-friendly layout; this is a PWA so it should look good on a phone.

Keep styling clean and simple (Tailwind is fine). Commit when done.
```

---

## Prompt 9: Demo mode + polish

```
Read ARCHITECTURE.md first. We demo in front of judges soon. Add:

1. A /demo page or a "Demo" button that runs a scripted scenario: Monday 7:15am,
   commuter from East End to the Medical Center, arrive by 8:30. Show the
   recommendation, then advance the clock so a train blockage becomes likely,
   show the reroute + updated "leave earlier" notification, then flip Safe Path
   and show the route change.
2. A README section "How real data plugs in" listing each DataSource interface
   and what real feed (TranStar, TrainWatch, Bluetooth sensors, cameras) would
   implement it.
3. Run all tests, fix failures, make sure `make dev` (or equivalent) starts both
   apps from a clean clone. Commit when done.
```

---

### Tips

- If Claude Code starts drifting, tell it: "re-read ARCHITECTURE.md and stick to it."
- If you're short on time, cut in this order: Prompt 4's crash risk, then the time slider in Prompt 8, then the WebPush stub. **Don't cut the train blockage model.** It's your differentiator.
- You've got BMAD installed. `/bmad-architecture` can do Prompt 1 more rigorously if you have the time, but for a 48-hour build the plain prompt is faster.
