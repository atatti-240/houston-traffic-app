# Devpost Submission Draft — BlindSpot

> Draft written Fri 2026-09-25 night. Lines marked **[UPDATE SUN]** must be checked against what we actually shipped before submitting.

## Project name
BlindSpot

## Elevator pitch (≤ 200 chars)
See what your map can't. BlindSpot tells Houston drivers when to leave, re-planning around blocked train crossings, traffic cameras and crash hotspots.

---

## About the project (paste everything below into "Project Story")

## Inspiration
Houston drivers lose **77 hours a year** to traffic (TTI Urban Mobility Report 2025), and the city has **700+ at-grade rail crossings**. Texas leads the country in blocked crossings, and Houston accounts for at least half of them. A parked freight train can block a street for close to an hour, and fire trucks get stuck behind trains roughly 100 times a month.

Google Maps and Waze are great at live traffic, but they have blind spots here. They don't know a train is blocking your crossing until cars pile up. They can't plan a day with several stops and arrival windows. And they don't use Houston's own data: TranStar's cameras and sensors, the City's Train Watch crossing sensors, or Vision Zero crash records. We wanted to build the app that fills those gaps.

## What it does
You tell BlindSpot where you need to be and when, for example *leave UH Sugar Land, be at UH main campus by 5 PM, then Ion District by 6 PM*. It tells you:
- the best **order** for your stops and the exact **time to leave** for each leg,
- which **rail crossings**, **jammed cameras** and **high-crash segments** are on your route,
- and it keeps watching. If a train blocks your route or traffic builds up, it **re-plans and sends an alert** with the reason, before you're stuck.

One tap on **Go** opens Waze or Google Maps for turn-by-turn navigation. We don't compete on navigation; we decide *when* and *in what order*.

## How we built it
- **Backend:** Python, FastAPI, SQLAlchemy and SQLite. A small Houston road graph with a time-dependent Dijkstra router and a Safe Path option.
- **Scoring models:** congestion, crash risk and train blockage per road segment (or crossing) and per 15-minute time bucket. Each is updated with an exponential moving average, where \\( \alpha \\) is the nudge factor:
$$ s_{t+1} = s_t + \alpha\,(x_t - s_t) $$
- **Route cost** for each edge at the time you'd reach it:
$$ c = t_{\text{travel}} + \sum_{\text{crossings}} \mathbb{E}[\text{train delay}] + \lambda_{\text{crash}} \cdot r_{\text{crash}} \cdot \text{miles} $$
  Safe Path raises \\( \lambda_{\text{crash}} \\).
- **Multi-stop planner:** with three stops there are only \\( 3! = 6 \\) orders, so we try every order and every departure time (every 15 minutes, refined to 5), and keep the lowest-cost plan that meets every arrival window.
- **Real Houston data:**
  - **Train Watch** (City of Houston ArcGIS layer): live status of 56 crossings.
  - **Houston TranStar**: 1,386 traffic cameras, live incident, lane-closure and travel-time RSS feeds, and 2011–2025 historical travel times per 15-minute departure slot.
  - **Vision Zero High Injury Network 2025**: 1,080 road segments, 4,620 severe crashes.
- **Computer vision:** YOLOv8 counts vehicles in TranStar snapshots. Each camera is compared with its own normal count, because camera angles differ.
- **Frontend:** Next.js, TypeScript, Tailwind and react-leaflet, phone-first, installable as a PWA for push alerts.
- **Our own history:** a logger recorded crossings, camera counts and incidents all weekend. TranStar doesn't archive camera images, so that record exists nowhere else. The demo replays it.

## Challenges we ran into
- **Live feeds were locked.** TranStar's JSON feeds returned 403. We found its public RSS feeds, which carry the same live incidents and travel times.
- **Cameras can't see the tracks.** We checked all 14 cameras within 200 m of a Train Watch crossing. None clearly shows the rails, so we detect train blockages from Train Watch plus car queues at the nearby intersection instead.
- **Broken and frozen cameras.** One camera returned a web page instead of an image, one showed "Camera error", and one was frozen on a frame from **July 2021**. Every snapshot is now validated, and stale cameras are marked as unknown instead of being trusted.
- **"Sensor DOWN" crossings still report changes.** The meaning isn't documented, so we show those crossings as *low confidence* instead of hiding them.
- **YOLO undercounts small cars** on 320×240 frames. Switching to a larger model at a higher input size raised the count on the same frame from 20 to 28 (about 30–35 visible).

## Accomplishments that we're proud of
- In our simulation, a 60-minute train blockage on the route added **54 minutes** to the normal plan. BlindSpot re-planned around it. On a normal day, reordering stops alone saved about 6 minutes. **[UPDATE SUN: add real test-drive results vs Google]**
- Everything runs on free, public Houston data. No paid APIs.
- Our weekend logger is, as far as we know, the only archive of Houston camera-based congestion and crossing blockages.

## What we learned
- The most valuable data was city infrastructure data that navigation apps ignore, not live speeds.
- "Unknown" is a valid answer. Showing low confidence honestly beats a confident wrong answer.
- Freeway routes rarely touch rail crossings. Train awareness matters most for East End and industrial-area trips, so that is where we focus.

## What's next for BlindSpot
- Partner with the City and vendors like TRAINFO or RailState for predictive train-arrival data.
- Add flooding (Harris County Flood Warning System) for underpasses.
- Expand the road graph beyond the demo corridors and add a Spanish interface.
- Share our blocked-crossing log with the City to support grade-separation grants.

---

## Built with (tags, ≤ 25)
python, fastapi, sqlalchemy, sqlite, uv, next.js, typescript, react, react-leaflet, leaflet, tailwindcss, yolov8, ultralytics, pytorch, pwa, web-push, openstreetmap, arcgis, houston-transtar, train-watch, vision-zero, rss, claude-code

## "Try it out" links
- Code: https://github.com/atatti-240/houston-traffic-app
- Live demo: **[UPDATE SUN: deployed URL]**

## Image gallery (3:2, ≤ 5 MB, up to 15)
1. `docs/assets/thumbnail.png`: cover
2. App screenshots: Plan screen with "Leave by", Live map, Alert **[UPDATE SUN]**
3. YOLO detection on a TranStar camera (boxes drawn)
4. Crossing-camera contact sheet (the "cameras can't see the tracks" challenge)
5. Architecture diagram
6. Demo trip table: leave-time vs. arrival (UH Sugar Land → UH → Ion)

## Video demo link
**[UPDATE SUN]** 2–3 min YouTube or Vimeo (unlisted is fine): problem (20 s) → plan a trip (40 s) → replayed train block and alert (40 s) → live map (20 s) → impact and data sources (20 s).
