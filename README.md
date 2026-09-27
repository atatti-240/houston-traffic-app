# BlindSpot

**Know when to leave and which way to go, before Houston traffic hits.**

Waze and Google Maps react to congestion after it has formed. This app predicts the stuff they're blind to:

- **Freight trains blocking at-grade crossings.** Learned per crossing, per 15 minutes of the week.
- **Crash-prone stretches of freeway.** Learned per road segment and hour, with a 🛡️ **Faster ↔ Safer** slider that steers around them.
- **Tomorrow's congestion.** A congestion score per road × 15-minute slot, nudged every day by a moving average.
- **Why it's slow.** Other maps paint a road red. BlindSpot splits the delay into its causes (rush hour, a crash, a concert, a freight train, lane closures, rain, construction, heavier than usual traffic) and puts an icon for each on the map.

Then it tells you **when to leave** (the latest departure that still gets you there on time) and pushes a plan, "leave earlier" / "new route" updates, a **"Leave now"** alert, and **"it's cleared"** when a road you're watching is back to normal. Live train, traffic and incident reports override the predictions for the next half hour, and every answer says how sure it is and where the data came from. Errands with up to 3 stops get the best stop order and departure times.

> Built in 48 hours. All data is synthetic for now, behind interfaces that the real TranStar / TrainWatch feeds plug into. See [How real data plugs in](#how-real-data-plugs-in).

## Project docs

- Product brief: [docs/product-brief.md](docs/product-brief.md) · Build prompts: [docs/build-prompts.md](docs/build-prompts.md)
- Design spec: [docs/specs/2026-09-25-houston-commute-planner-design.md](docs/specs/2026-09-25-houston-commute-planner-design.md)
- Implementation plan (roles A-E, checkpoints): [docs/plans/2026-09-25-houston-commute-planner-plan.md](docs/plans/2026-09-25-houston-commute-planner-plan.md)
- Outline + decisions: [docs/outline.md](docs/outline.md) · Data research: [docs/feature-notes.md](docs/feature-notes.md)
- Sample API JSON: [docs/contracts/](docs/contracts/) (also in `frontend/public/mock/`). `POST /plan`, `GET /plan/{id}` and `GET /live` follow these shapes, with two differences: times are naive Houston local time (no `-05:00`), and fields a feed doesn't provide yet (camera vehicle counts, `stale`, `high_injury_segments_url`) are `null`. Both endpoints also return a few extra fields
- Routing wiring (which decision uses which data, priority rules): [docs/routing-wiring.md](docs/routing-wiring.md)
- Website style guide: [docs/website-style.md](docs/website-style.md)
- Data-source spikes (throwaway): [spikes/](spikes/)

## Run it

Needs [uv](https://docs.astral.sh/uv/) (Python 3.11+) and Node 20+.

```bash
make setup   # install backend + frontend deps
make dev     # API on :8000, app on :3000
```

Open http://localhost:3000 and hit **▶ Demo**.

On first boot the backend builds the Houston road network and replays 8 weeks of synthetic history into the models. That takes a few seconds. To rebuild from scratch: `make seed`.

API docs: http://localhost:8000/docs

| Command | What |
|---|---|
| `make backend` / `make frontend` | run one side |
| `make seed` | wipe and rebuild `backend/data/app.db` (network + history replay) |
| `make roads` | re-trace the road shapes along the real streets (writes `backend/app/seed/road_shapes.json`) |
| `make test` | backend pytest + frontend typecheck |

Config (env vars): `SIM_START` (default Monday `2026-09-28T07:15:00`), `CLOCK_SPEED` (simulated seconds per real second, default `1`), `HISTORY_WEEKS` (`8`), `SYNTHETIC_SEED` (`42`), `NEXT_PUBLIC_API_URL` (frontend → API, default `http://localhost:8000`).

## The demo (≈3 minutes)

The **▶ Demo** button walks through this with narration. Click **Next** to go at your own pace. On a phone it's a compact bar at the top; tap the title for the narration.

1. **Monday 7:05 AM.** *Where to?*, with the traffic around you right now.
2. **East End → Medical Center, arrive by 8:00.** A traffic-only route uses Cullen Blvd, where a train crosses ~72% of weekday mornings around 7:40. BlindSpot routes around it (*"Avoided Cullen Blvd @ UP: 72% chance of a train around 7:38 AM"*) and says **leave at 7:35**.
3. **Live train on Old Spanish Trail.** The trip re-plans right away: *"Rerouted around Old Spanish Trail @ Almeda: blocked by a train right now"*.
4. **5 PM: why Houston is slow.** The live map shows an icon for every cause: rush hour, a concert at Toyota Center, a crash on the Gulf Freeway, a freight train on Navigation Blvd, lane closures on I-69, rain on the West Loop, construction on I-45 North, and a camera seeing more cars than usual on I-10.
5. **Tap the crash.** *"Multi-vehicle crash. Two left lanes blocked."* Heavy traffic, +12 min.
6. **Why it's slow.** 60% of the delay is the crash, 40% is rush hour, and the speed chart shows the drop at 4:52.
7. **Live cams.** The West Loop camera by the Galleria, in the rain.
8. **Alerts.** Incidents, roadwork, events, weather, trains and busier roads in one list, each with what it costs you.
9. **Downtown → Hobby by 5:45.** The Gulf Freeway is the usual way. With the crash on it, the route goes around: *"Rerouted around I-45 Gulf Fwy: crash reported"*.
10. **Notify me when it clears.** Watch the crash road and jump to 6:30 PM: *"I-45 Gulf Fwy southbound has cleared"*, even though it's still rush hour.

You can also use the app yourself: search a place and set **Leave now / Arrive by**, the **Faster ↔ Safer** slider and up to 2 extra stops (BlindSpot picks the order), then **Alert me**. On the live map, tap the time chips to see predicted traffic in 30 min to 2 h, filter by cause, and turn on the camera and rail-crossing layers. Tap any road for *Why it's slow*. Use **+15m** to move the simulated clock. The `/demo/*` endpoints in http://localhost:8000/docs fake every kind of live input: trains, sensor outages, traffic readings, incidents and whole feeds going down. You can also open a screen directly: `/?screen=map`, `causes`, `alerts`, `where`, `cameras&area=Galleria`, `why&id=<segment id>` or `trip&to=hobby&from=downtown&by=17:45&safety=1`.

## How it works

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full picture. The short version:

- **One model shape for everything.** Each model keeps a score per (thing, time bucket) and nudges it daily: `score += α × (today − score)`. Congestion: segment × 15-min slot. Trains: crossing × 15-min slot (+ average blockage length). Crashes: segment × weekday/weekend hour, pooled because crashes are sparse.
- **Time-dependent routing.** Each road is scored at the time you'd actually reach it: predicted travel time + expected train delay + a crash-risk penalty that grows up to ×20 as you slide toward Safer.
- **Live beats predicted, carefully.** Fresh live data is blended in for the next 30 min, incidents slow or close roads, and a feed that goes down falls back to predictions and says so. See [docs/routing-wiring.md](docs/routing-wiring.md).
- **Explainable.** Every route is compared with a traffic-only route (what a typical nav app would pick), and the differences become the "why" bullets.
- **Causes.** For each road the delay against free flow is split into usual traffic (rush hour), live volume, incidents, closure waits and trains, from the same data the router uses. A crash at 5 PM shows up as a crash, not as rush hour. See [ARCHITECTURE.md](ARCHITECTURE.md#why-its-slow).
- **Door to door.** Our router picks the corridor; the public OSRM router (OpenStreetMap) draws the whole trip on real roads to the door, with turn-by-turn steps and lane arrows, and up to 3 routes to pick from on the map. Checked against our route, cached, one request a second, and the app carries on without it. See [ARCHITECTURE.md](ARCHITECTURE.md#directions).

```
backend/   FastAPI + SQLite: adapters (mock data), scoring models, router, recommender, planner, causes, scheduler, API
frontend/  Next.js PWA + Leaflet over a MapLibre street map, dark UI: Where to, Trip, Live map, Causes, Why it's slow, Alerts, Live cams, scripted demo
```

## How real data plugs in

Every source is an interface in `backend/app/adapters/base.py`. Today each one has a `Mock*` implementation in `adapters/mock.py` built on the deterministic synthetic world (`app/seed/synthetic.py`). To go live, write a real implementation and register it in `build_sources()` behind `DATA_SOURCE=live`. Nothing else changes: the router only reads the road-conditions layer, which already handles live data, confidence and feed outages. [docs/routing-wiring.md](docs/routing-wiring.md) has the rules each adapter must follow.

| Interface | Returns | Real feed |
|---|---|---|
| `SpeedSource.observations(day)` | speed per segment per 15-min slot | Houston TranStar speed / travel-time data (its Bluetooth AVI readers), plus TranStar historical archives to backfill |
| `CrashSource.crashes(day)` | crashes with segment + time | TranStar incident feed (live), TxDOT CRIS crash records (history) |
| `TrainSource.crossing_events(day)` | blockage start/end per crossing | TrainWatch data / crossing sensors, FRA blocked-crossing reports |
| `TrainSource.crossing_status(now)` | every crossing's live status: blocked/clear, sensor up/down, expected clear time | Train Watch (ArcGIS), crossing sensors. Also where camera-based detection would plug in |
| `LiveTrafficSource.current(now)` | live congestion per segment (0-1) with source and confidence | TranStar RSS live travel times, camera vehicle counts vs each camera's baseline |
| `IncidentSource.active(now)` | incidents and closures matched to segments | TranStar RSS incidents and lane closures |
| `CameraSource.cameras()` | camera catalog | TranStar CCTV list + train crossing cameras |

Live methods are called once per request, so cache the upstream for about a minute, and raise when it's down. The app marks the feed down and falls back to predictions.

The one step real feeds need is **map matching**: snap each sensor, incident or crossing to a `RoadSegment` id. The seeded graph (`app/seed/network.py`) is a hand-built graph of the major corridors; each segment is drawn along the real road, traced once from OpenStreetMap (`make roads`, saved in `app/seed/road_shapes.json`). Swapping in a full OpenStreetMap road graph keeps the same schema.

Notifications work the same way: `NotificationService` has a mock (stored and polled by the app, plus browser notifications via the service worker). `WebPushNotificationService` is the stub where VAPID keys and `pywebpush` go.

## Status

- ✅ Models, routing, recommender, multi-stop planner, causes, scheduler, API, UI, demo: all working, 170 backend tests
- ✅ Road-conditions layer with priority rules for live vs predicted data, tested with mock live feeds
- 🧪 Data: synthetic, with patterns baked in for the models to rediscover (rush hours, crash hot spots, recurring trains)
- ✅ UI: phone-first dark design (full-screen screens on a phone, a side panel next to the map on desktop), installable PWA
- ✅ Map: free dark vector street map ([OpenFreeMap](https://openfreemap.org), no key), roads traced along the real streets, and shops and places as colored dots with names (tap one for directions). Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors
- ⏭️ Next: real TranStar/TrainWatch adapters (`adapters/real/`), real camera feeds, full OSM road graph, real web push, the marketing website
