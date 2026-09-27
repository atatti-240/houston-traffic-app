# BlindSpot

**Know when to leave and which way to go, before Houston traffic hits.**

Waze and Google Maps react to congestion after it has formed. This app predicts the stuff they're blind to:

- **Freight trains blocking at-grade crossings.** Learned per crossing, per 15 minutes of the week.
- **Crash-prone stretches of freeway.** Learned per road segment and hour, with a 🛡️ **Faster ↔ Safer** slider that steers around them.
- **Tomorrow's congestion.** A congestion score per road × 15-minute slot, nudged every day by a moving average.
- **Why it's slow.** Other maps paint a road red. BlindSpot splits the delay into its causes (rush hour, a crash, a concert, a freight train, lane closures, rain, construction, heavier than usual traffic) and puts an icon for each on the map.
- **Live AI cameras.** Real traffic-camera video with the team's computer-vision app ([blindspot-cv](https://github.com/qian-json/blindspot-cv)) drawing a box around every vehicle, counting them, reading rough speeds and checking for incidents. An incident the camera confirms goes on the map, into Alerts and "Why it's slow", and routes go around it. Baton Rouge live video stands in for Houston cameras until we have Houston live video. See [Live AI camera feeds](#live-ai-camera-feeds).

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
make setup     # install backend + frontend deps
make transit   # once: download METRO's timetable (~13 MB) for the Transit tab
make dev       # API on :8000, app on :3000
```

**Running the demo? Run `make transit` once first** on that machine. It downloads METRO's bus and rail timetable and builds `backend/data/transit.db` (not in git). Without it the Transit tab only says the timetable isn't loaded; everything else works.

Open http://localhost:3000 and hit **▶ Demo**.

On first boot the backend builds the Houston road network and replays 8 weeks of synthetic history into the models. That takes a few seconds. To rebuild from scratch: `make seed`.

API docs: http://localhost:8000/docs

| Command | What |
|---|---|
| `make backend` / `make frontend` | run one side |
| `make seed` | wipe and rebuild `backend/data/app.db` (network + history replay) |
| `make roads` | re-trace the road shapes along the real streets (writes `backend/app/seed/road_shapes.json`) |
| `make limits` | look up speed limits and toll roads in OpenStreetMap (writes `backend/app/seed/road_limits.json`) |
| `make transit` | download METRO's bus and rail timetable (GTFS, about 13 MB) and build `backend/data/transit.db` for the Transit tab |
| `make test` | backend pytest + frontend typecheck |
| `make cv-fake` | a stand-in for the CV app on :8500 (recorded Baton Rouge frames, scripted incident); see [Live AI camera feeds](#live-ai-camera-feeds) |
| `make dev-cv` | `make dev` plus the fake CV app, with `CV_URL` set: live AI cameras without the CV app |

Config (env vars): `SIM_START` (default Monday `2026-09-28T07:15:00`), `CLOCK_SPEED` (simulated seconds per real second, default `1`), `HISTORY_WEEKS` (`8`), `SYNTHETIC_SEED` (`42`), `NEXT_PUBLIC_API_URL` (frontend → API, default `http://localhost:8000`), `NOMINATIM_URL` (address and business search, default the free public server `https://nominatim.openstreetmap.org`; point it at your own Nominatim for heavier use). Live AI cameras: `CV_URL`, `CV_CAMERAS`, `CV_VIEW`, `CV_VIDEO_DELAY_S`, `CV_CLEAR_AFTER_S` (see [Live AI camera feeds](#live-ai-camera-feeds)).

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
9. **Drivers report what they see.** Flooding on Westheimer by the Galleria, with *Still there* / *Not there* (the scenario's canned reports are labeled *Demo report*).
10. **Downtown → Galleria.** The only way in crosses the flood: *"Flooding on your route. Turn around, don't drown."*
11. **Downtown → Hobby by 5:45.** The Gulf Freeway is the usual way. With the crash on it, the route goes around: *"Rerouted around I-45 Gulf Fwy: crash reported"*.
12. **Notify me when it clears.** Watch the crash road and jump to 6:30 PM: *"I-45 Gulf Fwy southbound has cleared"*, even though it's still rush hour.

You can also use the app yourself: search a place and set **Leave now / Arrive by**, the **Faster ↔ Safer** slider and up to 2 extra stops (BlindSpot picks the order), then **Alert me**. On the live map, tap the time chips to see predicted traffic in 30 min to 2 h, filter by cause, and turn on the camera and rail-crossing layers. Tap any road for *Why it's slow*. Use **+15m** to move the simulated clock. The `/demo/*` endpoints in http://localhost:8000/docs fake every kind of live input: trains, sensor outages, traffic readings, incidents and whole feeds going down. You can also open a screen directly: `/?screen=map`, `causes`, `alerts`, `where`, `cameras&area=Galleria`, `why&id=<segment id>`, `trip&to=hobby&from=downtown&by=17:45&safety=1` or `nearby&kind=fuel` (`ev`, `parking`). On a trip, the **Walk**, **Bike** and **Transit** tabs give walking and cycling directions and METRO bus and rail trips (`trip&to=galleria&from=downtown&travel=transit`; run `make transit` once to load the timetable).

### Places

- **Search any address or business.** *Where to* finds our own places first, then anything in the Houston area from [OpenStreetMap](https://www.openstreetmap.org/copyright) through its free geocoder, Nominatim (`GET /geocode?q=`), nearest first. Tap one for the trip there.
- **Place cards.** Tap a shop or place on the map (or open a search result) for its card: **"Open now, closes 9 PM"** with the week's hours, phone, website, and Directions. On the trip it also says when the place will be closed, or closing, by the time you get there. What OpenStreetMap doesn't know, the card leaves out (no ratings: OSM has none).
- **Home, Work and favorites.** Chips on *Where to* (with the drive time) and an editor to set, change or remove them. Star any place to keep it; favorites show as stars on the map. Saved in the browser only, no accounts.
- **Gas, EV chargers, parking.** Turn them on in the map's layers menu (from zoom 13), or open **Gas near me** there, or **Gas on the way** from a trip: the closest few with distance, each with its card.

The public Nominatim server allows one request per second for the whole app and discourages search-as-you-type, so the backend rate-limits, caches every answer (memory + SQLite, and serves an older answer, marked as such, when the geocoder is down), and the app waits for a pause in typing, needs 3 letters and keeps one request in flight. For anything bigger than a demo, set `NOMINATIM_URL` to your own Nominatim. When search is down, our own places still work and the app says so.

## Live AI camera feeds

The team's computer-vision app, [blindspot-cv](https://github.com/qian-json/blindspot-cv), runs as its own process. It plays live traffic-camera video, finds every vehicle (car, truck, bus, motorcycle), estimates rough speeds and, on an Apple-silicon Mac, runs an incident check (a small vision-language model looks for crashes, stalled cars, people on foot, wrong-way drivers and debris). BlindSpot talks to it over HTTP only, through `CV_URL`, so it can run on this machine, on a teammate's Mac, or anywhere on the network.

What you get on **Live cams**:

- Cameras with a live AI feed come first, marked **LIVE AI** (and red on the map's camera layer). Their card plays the real video with a box around each vehicle (tap the box button to hide them), a **LIVE** badge, pause and full screen.
- Under it: vehicles in view (by kind), traffic as **flowing / slow / stopped** with a rough mph (the CV app's speeds are ±30% or worse, so we only trust those three words), and the incident check: clear, **possible** (one check flagged it: shown on the card only) or **confirmed** (2 of its last 3 checks) with the model's one-line description.
- A **confirmed** incident becomes a live incident on the camera's Houston road, like one from TranStar: it slows the road, shows on the map and in "Why it's slow" and Alerts as "Crash spotted by camera AI" with the model's description, and routes go around it ("Rerouted around I-45 Gulf Fwy: crash reported (camera AI, just now)"). Watched trips re-plan right away. It clears once the camera has seen a clear road for `CV_CLEAR_AFTER_S` (2 min), or 10 min after the camera stops reporting. Possible incidents never touch routing.
- Without a feed (no `CV_URL`, the CV app down or not running that camera) the card keeps the drawn view and says the live AI feed is offline. Nothing else changes.

**Stand-ins, honestly labeled.** We don't have Houston live video yet, so the CV app's Baton Rouge cameras (Louisiana DOTD live streams) stand in for Houston cameras on similar freeways: by default Baton Rouge I-10 @ College Dr (`007`) for our I-45 Gulf Fwy @ Telephone Rd camera, and I-10 at Perkins (`009`) for I-10 Katy Fwy @ 610 West. The card says so under the video, and incidents say "Baton Rouge live video standing in". Vehicle counts and speeds stay on the card: they're Baton Rouge traffic, so they don't change Houston congestion. Only confirmed incidents feed the rest of the app, to show the whole chain working.

### Run it

```bash
# 1. The CV app (see its README; Python 3.12+). On an Apple-silicon Mac, with the incident check:
git clone https://github.com/qian-json/blindspot-cv.git && cd blindspot-cv
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python transtar_feed.py --la-cameras 007 009 --no-demo          # serves :8500
#    Anywhere else (no incident check, lighter detector, CPU friendly):
.venv/bin/python transtar_feed.py --incidents off --detector yolo11s-hd --la-cameras 007 009 --live-fps 1 --no-demo

# 2. BlindSpot, pointed at it
CV_URL=http://localhost:8500 make dev
```

The CV app on another computer: start it with `--host 0.0.0.0` and use `CV_URL=http://<its address>:8500`. The incident check needs an Apple-silicon Mac (M1-M4); elsewhere the CV app runs without it and the card says "Incident check off".

**No CV app, or no Mac?** `make dev-cv` runs everything with a fake CV server (`backend/scripts/fake_cv.py`, standard library only) that serves the same stream from 57 real frames recorded from the Baton Rouge I-10 @ College Dr camera, each with the boxes the CV app's detector found. Its incident is scripted and labeled as a test: `curl -X POST localhost:8500/incident` starts one (possible, confirmed 4 s later, the camera sees a clear road again after 90 s, and BlindSpot clears it 2 min after that), `curl -X POST 'localhost:8500/incident?clear=1'` ends it early, or start it with `make cv-fake CV_FAKE_ARGS="--incident-after 20"`. A good trip to try while it's on: Midtown → Hobby Airport (`/?screen=trip&from=midtown&to=hobby`) goes around the Gulf Freeway.

| Env var | Default | What |
|---|---|---|
| `CV_URL` | empty (off) | The CV app's address, e.g. `http://localhost:8500` |
| `CV_CAMERAS` | `007=cam_I45S_downtown_gulf_ee,009=cam_I10W_downtown_i10_610w` | Which CV camera stands in for which of our cameras (`GET /cameras` lists ours). Test-clip cameras (`replay1`, ...) can be mapped too |
| `CV_VIEW` | `follow` | Which camera the CV app processes, see below |
| `CV_VIDEO_DELAY_S` | `2.5` | The video plays this far behind so the boxes, which arrive a moment after their frame, land on the right cars |
| `CV_CLEAR_AFTER_S` | `120` | A confirmed incident clears once the camera has seen a clear road this long |

**`CV_VIEW`: which camera runs.** The CV app processes one camera at a time by default (running them all is heavy). `follow` switches it to the camera someone is watching in BlindSpot, and back to the first mapped camera when nobody is, so that one keeps being checked for incidents; the trade-off is that the other cameras aren't checked while they're off screen, and two people watching different cameras take turns (30 s each, the other card says the camera AI is busy meanwhile). `all` runs every camera all the time (every camera is checked, but it's heavy, and it also wakes the CV app's TranStar snapshot cameras, which it then polls at its own rate). `off` never changes what the CV app is doing (use its own page at :8500 to pick).

Endpoints: `GET /cv/status` (connected, mapping, what it's processing, incident check on or off, confirmed incidents), `GET /cv/cameras/{camera_id}` (status, counts, flow and rough mph, incident check, recent vehicle boxes with their frame times; `?since=` epoch ms for only newer ones), `GET /cv/cameras/{camera_id}/video` (MJPEG, for a plain `<img>`), `GET /cv/cameras/{camera_id}/frame.jpg` (one frame, `?at=` epoch ms). `GET /cameras` and `GET /live` give each camera a `live_feed` summary (`null` when it has none).

On a trip, **Share ETA** makes a read-only link (`/share/<id>`, good until 6 hours after you leave) with the route and an ETA that re-checks traffic along it every minute. See [ARCHITECTURE.md](ARCHITECTURE.md#share-eta).

**Report** (on the map, and over the map on a trip) reports a crash, police, a hazard, a pothole, a stalled car or flooding where you are or at a spot you tap, snapped to the road direction it's on. Tap a report's pin for *Still there* / *Not there*. Crashes, stalled cars and flooding slow the road for routing; see [docs/driver-reports.md](docs/driver-reports.md).

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
| Camera AI (`app/cv/`, not an adapter) | live video, vehicle boxes, counts, rough speeds, confirmed incidents | The team's blindspot-cv app over `CV_URL` (Baton Rouge live video standing in today); Houston live video plugs into the same app |

Live methods are called once per request, so cache the upstream for about a minute, and raise when it's down. The app marks the feed down and falls back to predictions.

The one step real feeds need is **map matching**: snap each sensor, incident or crossing to a `RoadSegment` id. The seeded graph (`app/seed/network.py`) is a hand-built graph of the major corridors; each segment is drawn along the real road, traced once from OpenStreetMap (`make roads`, saved in `app/seed/road_shapes.json`). Swapping in a full OpenStreetMap road graph keeps the same schema.

Notifications work the same way: `NotificationService` has a mock (stored and polled by the app, plus browser notifications via the service worker). `WebPushNotificationService` is the stub where VAPID keys and `pywebpush` go.

## Status

- ✅ Models, routing, recommender, multi-stop planner, causes, scheduler, API, UI, demo: all working, 170 backend tests
- ✅ Road-conditions layer with priority rules for live vs predicted data, tested with mock live feeds
- 🧪 Data: synthetic, with patterns baked in for the models to rediscover (rush hours, crash hot spots, recurring trains)
- ✅ UI: phone-first dark design (full-screen screens on a phone, a side panel next to the map on desktop), installable PWA
- ✅ Map: free dark vector street map ([OpenFreeMap](https://openfreemap.org), no key), roads traced along the real streets, and shops and places as colored dots with names (tap one for its card and directions). Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors
- ✅ Places: search any Houston address or business, place cards with hours / phone / website, Home / Work / favorites, gas / EV / parking near you or along your route (all OpenStreetMap, free, no keys)
- ✅ Live AI cameras: real video from the team's CV app with vehicle boxes, counts, rough speeds and its incident check; confirmed incidents drive causes, alerts and routing. Baton Rouge video stands in for Houston cameras; a fake CV server with recorded frames covers tests and Mac-less demos
- ✅ Walk / Bike / Transit tabs: walking and cycling directions from OpenStreetMap ([FOSSGIS routing](https://routing.openstreetmap.de)), and METRO\* trips with at most one change on the scheduled [GTFS](https://www.ridemetro.org/about/business-to-business/developer-portal) timetable (no live bus tracking). Route and arrival data provided by permission of METRO\*. (\* METRO is the registered trademark of the Metropolitan Transit Authority of Harris County, Texas. All rights reserved.)
- ⏭️ Next: real TranStar/TrainWatch adapters (`adapters/real/`), Houston live camera video, full OSM road graph, real web push, the marketing website
