# Routing wiring: where each decision gets its data

The routing decisions are built and tested on mock data. Real feeds only have to fill in
the adapter methods below. The router, planner and alerts don't change.

```
real feeds ──> adapters/real/*  ──>  conditions/provider.py  ──>  routing/router.py ──> recommender.py (one trip)
 (TranStar,     (you write these)    ConditionsView: one           time-dependent          planner.py (multi-stop)
  Train Watch,                       snapshot per request,         Dijkstra                   │
  cameras)                           priority rules, confidence                               v
                                                                                  notifications/scheduler.py
```

The router reads only `ConditionsView`. It never calls an adapter itself, so every decision
comes from one snapshot of the data and says where that data came from.

## The decisions and what feeds them

| Decision | Data it needs | Adapter method | If the data is missing or the feed is down |
|---|---|---|---|
| Travel time on a road at the moment you reach it | Predicted congestion per segment × 15 min | `SpeedSource.observations(day)` (history, replayed into the EMA model) | Free-flow speed with no history. Confidence `low` |
| Correct that prediction with what's happening now | Live congestion per segment (0 = free, 1 = stopped) | `LiveTrafficSource.current(now)` → `LiveTraffic` | Prediction only. Confidence `low` for the next 30 min while the feed is down |
| Slow down or remove a road | Incidents matched to a segment | `IncidentSource.active(now)` → `Incident` | No slowdown. An incident with `segment_id=None` shows on `/live` but doesn't affect routing |
| Wait at a crossing, or go around it | Live crossing status + sensor health | `TrainSource.crossing_status(now)` → `CrossingStatus` | Predicted `p_block`. Confidence `low` for the next 30 min |
| Predicted train delay at a crossing | Blockage history per crossing × 15 min | `TrainSource.crossing_events(day)` | No train delay |
| Crash-risk penalty (safety slider) | Crash history per segment × hour | `CrashSource.crashes(day)` | Small prior risk everywhere |
| Camera pins and snapshots | Camera catalog | `CameraSource.cameras()` | No cameras on the map |

## Priority rules (in `app/conditions/provider.py`)

**Crossings**, when you'd arrive at time T:

1. Live **blocked** and T is before it clears → wait until it clears. Confidence `high`, or `low` if the crossing's sensor is down. We still use it when the sensor is down, but we flag it.
2. Live **clear**, sensor up and T within 5 min of now → no wait. Confidence `high`.
3. Otherwise use the prediction: `p_block × average blockage × 0.5`. Confidence `medium`, or `low` if the sensor is down, the status is more than 15 min old, or the train feed is down and T is soon.

**Road speed**, when you'd enter the road at time T:

- A live reading counts only while it's fresh: 10 min on freeways, 30 min on streets.
- It is blended with the prediction instead of replacing it:
  `weight = 0.8 × (1 − minutes_ahead / 30) × confidence_factor`, where the factor is 1 for high, 0.75 for medium and 0.5 for low.
  So live data dominates right now, fades out by 30 min, and one bad reading can't take over.
- More than one source on the same road (for example a camera and TranStar) are averaged by confidence. The source is recorded as `live:camera+transtar_rss`.

**Incidents:**

- A closure shuts the road until it clears. The router treats it like a blocked crossing: it either waits for the road to reopen or goes around, whichever is cheaper. A closure never makes a trip impossible.
- Other kinds slow it down until they clear: crash ×1.6, roadwork ×1.3, stall or hazard ×1.2, plus 0.25 for every extra blocked lane, up to ×3.
- With no clear time we assume 45 min from the start, and at least 15 more minutes from now.

**Feeds:** a live method that raises is marked down. Everything falls back to predictions, the route's `feeds_down` lists the feed, and the "why" bullets say so. Inputs in the next 30 min are marked low confidence: crossings when the train feed is down, and every road when the traffic or incident feed is down, since a crash or closure could be missing.

**Past times:** live data describes the present. For a time more than 15 min before now, for example when the map's time slider is scrubbed back, live traffic and crossing status are ignored, and an incident counts only if it had already started by then.

## Contracts for real adapters

The records are defined in `app/conditions/live.py`:

```python
LiveTraffic(segment_id, congestion, source, observed_at, confidence="high", detail="")
Incident(id, title, kind, segment_id, started_at, source, updated_at, clears_at=None, lanes_blocked=1, detail="")
CrossingStatus(crossing_id, blocked, sensor_up, updated_at, source, clears_at=None)
```

Rules for real adapters:

- **Map-match first.** `segment_id` and `crossing_id` must be ids from our graph (`GET /segments`, `GET /crossings`). Anything you can't match: drop live traffic readings, and send incidents with `segment_id=None` so they're still listed.
- **Convert to our scale.** `congestion` runs from 0 to 1.
  - TranStar: `1 − free_flow_time / live_time`, clamped.
  - Cameras: vehicle count against *that camera's own* baseline, never an absolute count.
  - Set `confidence="low"` for anything shaky, such as a frozen camera or a count from a partly blocked view.
- **Be cheap.** Live methods are called once per request. Cache the upstream response for about a minute.
- **Fail loudly.** Raise `FeedUnavailable` (or anything else) when the upstream is down or returns garbage. The conditions layer catches it. Never return stale data as if it were fresh.
- **Train Watch:** return every crossing you know about, blocked or clear, with `sensor_up`, so "sensor down" can be shown even when nothing is blocked.
- **Times** are naive Houston local time, matching the simulated clock. Use `app.timeutil.to_local_naive()` on anything with a UTC offset.

## Where to see it working without real data

The demo endpoints fake every live input:

| Endpoint | Fakes |
|---|---|
| `POST /demo/block-crossing` | a train blocking a crossing |
| `POST /demo/crossing-sensor` | a crossing sensor going down or coming back |
| `POST /demo/live-traffic` | camera or TranStar readings on segments |
| `POST /demo/incident` | a crash, stall, roadwork or closure |
| `POST /demo/feed` | a whole feed going down (`trains`, `traffic`, `incidents`) |
| `POST /demo/clear-live` | drop all of the above |

Every one of them re-checks saved trips and re-plans watched plans right away.
`GET /live` shows what the router currently sees. `tests/test_conditions.py`,
`tests/test_planner.py` and `tests/test_plans_api.py` pin down the behavior.

## Multi-stop plans (`app/planner.py`)

`POST /plan` takes the request in `docs/contracts/trip_request.json` and returns
`plan_result.json`:

- **Search.** It tries every stop order (at most 3 stops, so at most 6 orders). Stops marked `fixed_order` keep their typed position. Each order is tried with first departures every 15 min for the next 2 h, plus every 15 min in the 2 h before each stop's target time, so a window later in the day still gets a departure close to it. The best one is then refined to 5 min.
- **First departure** aims to reach the first stop at its window start, or at its end minus the buffer when only an end is given. Time at home beats time waiting at a stop.
- **Later legs** leave when you're ready (arrival + dwell). They leave later only in two cases: to avoid arriving before a stop's window opens (and never so late that you'd get there after it opened), or to avoid sitting at a closed road when leaving later gets you there just as soon. For a stop with only an end time, arriving early costs nothing, and waiting at the previous stop would only put the stops after it at risk.
- **Cost.** `route cost + 0.5 × wasted waiting + 0.3 × minutes the first departure is later than it could be`. Route cost includes any wait at a closed road. Wasted waiting covers three cases: arriving at the first stop before its target, waiting at a later stop for its window to open, and idling at the previous stop before leaving for it.
- **Times.** ISO times with an offset are converted to Houston time. `HH:MM` for `depart_after` means the next time that clock time comes up (the current minute counts as now). `HH:MM` window times start on the departure's day. Each window moves to the next day on its own when its end has already passed (`08:00`-`08:30` asked at 10 PM), or when it only has a start and that start is more than 12 h ago (`08:00` asked at 10 PM). A start-only window that has already opened also moves if another window in the request moved, so `08:00`-`08:30` then `09:00`, asked at 10 PM, are both tomorrow. A window still ahead today never moves, so `23:00`-`23:30` then `00:15`-`00:45` means tonight, then after midnight. The exception is a `fixed_order` stop whose window would close before the previous fixed stop's window opens; that one moves to the next day. An end at or before its start is overnight (`23:30`-`00:30`): the window you're inside right now, otherwise tonight's.
- **Ranking.** Fewest missed windows first, then fewest tight arrivals (inside the buffer), then least lateness, then lowest cost. If every order is late, the plan comes back with `status: "late"` and says by how much.
- **Baseline.** The typed order, leaving now, on traffic-only routes. `saved_min_vs_baseline` compares drive minutes against it.
- **Watched plans** (`watch: true`) are re-planned every 5 min until you leave, right away when live data changes, and on the tick your departure comes due, so "leave now" always uses fresh conditions. Their alerts are `plan`, `order_changed`, `leave_earlier`, `leave_later`, `leave_now` (one per leg) and `info`.
  - If the departure you were told gets pushed back just as it comes due, the alert is "Hold on: leave at …" (a `leave_later`) instead of "leave now". This happens at most once. After it, re-plans can only move the departure earlier, and "leave now" comes at the new time.
  - If a re-plan fails, the last good plan and its alerts stay in place.
  - A re-plan keeps the current stop order unless another order is better on lateness or saves at least 3 min. The order is tracked by stop position (`order_index`), because two stops can share a name. That way near-equal orders don't flip back and forth with a "New stop order" alert every few minutes. First departures are tried on quarter-hour clock marks for the same reason.
  - Once every stop's window has closed, the departure can only move earlier, just like after a "Hold on". A late plan's "leave now" still comes at its planned departure. If you never left and that departure has passed too, the plan stops being watched and sends one "Missed" alert (`info`). Stops without an end time never expire this way. Once you've left, the remaining legs' "leave now" alerts still come.
- **Safety slider.** `safety_weight` runs from 0 (fastest) to 1 (safest) and sets the crash penalty from 30 to 600 s per risk-weighted mile. The old `safe_path: true` means 1.0.
- **`leave_at_safe`** is `leave_at` minus a margin: 0, 5 or 10 min for high, medium or low confidence. Use it if you can't afford to be late.
