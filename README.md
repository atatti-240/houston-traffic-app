# BlindSpot

**Know when to leave and which way to go, before Houston traffic hits.**

Waze and Google Maps react to congestion after it has formed. This app predicts the stuff they're blind to:

- **Freight trains blocking at-grade crossings.** Learned per crossing, per 15 minutes of the week.
- **Crash-prone stretches of freeway.** Learned per road segment and hour, with a 🛡️ **Safe Path** toggle that steers around them.
- **Tomorrow's congestion.** A congestion score per road × 15-minute slot, nudged every day by a moving average.

Then it tells you **when to leave** (the latest departure that still gets you there on time) and pushes a plan, "leave earlier" / "new route" updates, and a **"Leave now"** alert.

> Built in 48 hours. All data is synthetic for now, behind interfaces that the real TranStar / TrainWatch feeds plug into. See [How real data plugs in](#how-real-data-plugs-in).

## Project docs

- Product brief: [docs/product-brief.md](docs/product-brief.md) · Build prompts: [docs/build-prompts.md](docs/build-prompts.md)
- Design spec: [docs/specs/2026-09-25-houston-commute-planner-design.md](docs/specs/2026-09-25-houston-commute-planner-design.md)
- Implementation plan (roles A-E, checkpoints): [docs/plans/2026-09-25-houston-commute-planner-plan.md](docs/plans/2026-09-25-houston-commute-planner-plan.md)
- Outline + decisions: [docs/outline.md](docs/outline.md) · Data research: [docs/feature-notes.md](docs/feature-notes.md)
- Sample API JSON: [docs/contracts/](docs/contracts/) (also in `frontend/public/mock/`)
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
| `make test` | backend pytest + frontend typecheck |

Config (env vars): `SIM_START` (default Monday `2026-09-28T07:15:00`), `CLOCK_SPEED` (simulated seconds per real second, default `1`), `HISTORY_WEEKS` (`8`), `SYNTHETIC_SEED` (`42`), `NEXT_PUBLIC_API_URL` (frontend → API, default `http://localhost:8000`).

## The demo (≈2 minutes)

The **▶ Demo** button walks through this with narration. Click **Next** to go at your own pace.

1. **Monday 7:05 AM.** The map shows predicted congestion building.
2. **East End → Medical Center, arrive by 8:00.** A traffic-only route uses Cullen Blvd, where a train crosses ~72% of weekday mornings around 7:40. We route around it: *"Avoided Cullen Blvd @ UP: 72% chance of a train around 7:38 AM · about 7 min faster than a traffic-only route"*, and say **leave at 7:35**.
3. **Save it.** The trip is now watched on weekdays; a plan alert arrives.
4. **Live train on Old Spanish Trail.** A *"New route"* alert: *"Rerouted around Old Spanish Trail @ Almeda: blocked by a train right now"*.
5. **7:35 AM.** *"Leave now"* alert with the route.
6. **Evening: Downtown → Hobby.** The fastest route is the crash-prone I-45 Gulf Freeway.
7. **Safe Path on.** The route skips the crash-prone stretch of the Gulf Freeway from downtown to 610: *"Safe Path: 35% less crash exposure than the traffic-only route for +6 min"*.

You can also use the app yourself: pick places or click the map (📍), scrub the time slider to watch rush hour build, toggle crash-risk / crossing / camera layers, and use **+15m / +1h** to move the simulated clock.

## How it works

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full picture. The short version:

- **One model shape for everything.** Each model keeps a score per (thing, time bucket) and nudges it daily: `score += α × (today − score)`. Congestion: segment × 15-min slot. Trains: crossing × 15-min slot (+ average blockage length). Crashes: segment × weekday/weekend hour, pooled because crashes are sparse.
- **Time-dependent routing.** Each road is scored at the time you'd actually reach it: predicted travel time + expected train delay + a crash-risk penalty (×20 with Safe Path).
- **Explainable.** Every route is compared with a traffic-only route (what a typical nav app would pick), and the differences become the "why" bullets.

```
backend/   FastAPI + SQLite: adapters (mock data), scoring models, router, recommender, scheduler, API
frontend/  Next.js PWA + Leaflet: map, trip planner, time slider, alerts, scripted demo
```

## How real data plugs in

Every source is an interface in `backend/app/adapters/base.py`. Today each one has a `Mock*` implementation in `adapters/mock.py` built on the deterministic synthetic world (`app/seed/synthetic.py`). To go live, write a real implementation and register it in `build_sources()` behind `DATA_SOURCE=live`. Nothing else changes.

| Interface | Returns | Real feed |
|---|---|---|
| `SpeedSource.observations(day)` | speed per segment per 15-min slot | Houston TranStar speed / travel-time data (its Bluetooth AVI readers), plus TranStar historical archives to backfill |
| `CrashSource.crashes(day)` | crashes with segment + time | TranStar incident feed (live), TxDOT CRIS crash records (history) |
| `TrainSource.crossing_events(day)` | blockage start/end per crossing | TrainWatch data / crossing sensors, FRA blocked-crossing reports |
| `TrainSource.active_blockages(now)` | crossings blocked right now | Same, live. Also where camera-based detection would plug in |
| `CameraSource.cameras()` | camera catalog | TranStar CCTV list + train crossing cameras |

The one step real feeds need is **map matching**: snap each sensor, incident or crossing to a `RoadSegment` id. The seeded graph (`app/seed/network.py`) is a hand-built sketch of the major corridors; swapping in OpenStreetMap-derived segments keeps the same schema.

Notifications work the same way: `NotificationService` has a mock (stored and polled by the app, plus browser notifications via the service worker). `WebPushNotificationService` is the stub where VAPID keys and `pywebpush` go.

## Status

- ✅ Models, routing, recommender, scheduler, API, map UI, demo: all working, 41 backend tests
- 🧪 Data: synthetic, with patterns baked in for the models to rediscover (rush hours, crash hot spots, recurring trains)
- ⏭️ Next: real TranStar/TrainWatch adapters, OSM road graph, real web push, computer vision on camera feeds
