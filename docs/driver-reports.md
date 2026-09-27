# Driver reports

Drivers report what they see on the road: **Crash, Police, Hazard (an object on the road),
Pothole, Stalled car, Flooding**. Other drivers confirm with **Still there** or **Not there**.
Code: `backend/app/reports.py` (rules, table, snapping, limits), `backend/app/api/reports.py`
(endpoints), `frontend/lib/reports.ts` (kinds, API, store), `frontend/components/map/Reports.tsx`
(pins, pick a spot) and `frontend/components/reports/` (Report button and sheet, the card).

## Where a report goes

A report is made at **where I am** (the app's `here`: the device location, or Midtown when
location is off, which the sheet says) or at a **spot tapped on the map** ("pick a spot").

- It snaps to the road direction whose drawn line is closest. The map draws each direction of a
  road 55 m to the right of travel, so tapping a direction's line picks that direction. The sheet
  shows the road it snapped to (*"I-69 Southwest Fwy westbound"*) and offers **Other direction**
  when the other direction runs there too (one-way pairs like Westheimer by the Galleria can be a
  block apart).
- More than 150 m from any road we know, it stays a **pin only**: listed, shown on the map, never
  routed around.
- The same kind already reported within 300 m on the same road counts as a **Still there** on that
  report instead of a second one.

## What it does

A report on one of our roads becomes an `Incident` (source `drivers`) in the road-conditions layer,
so routing, Why it's slow, Causes, Alerts, route reasons and "notify me when it clears" all see it:

| Report | Incident kind | Effect on the road | Cause shown |
|---|---|---|---|
| Crash | `crash` | ×1.6 | Crash |
| Stalled car | `stall` | ×1.2 | Crash ("Stalled vehicle") |
| Flooding | `flooding` | ×2 | Weather ("Flooding") |
| Hazard | `hazard` | ×1.2 | Crash ("Hazard on the road") |
| Police | `police` | none: heads-up only | (listed, never a cause) |
| Pothole | `pothole` | none: heads-up only | (listed, never a cause) |

- Water covers the whole road: a flooding report also floods the other direction where the two
  run within 70 m of each other there (a divided freeway's two sides are 20-60 m apart; one-way pairs
  a block apart, like Westheimer by the Galleria, are separate roads). Crashes and the rest stay on
  their own side.
- A road counts only its worst incident, so a crash report under a two-lane closure adds nothing
  (the card says *"Another incident already slows this road more"*).
- Driver reports aren't the incidents feed: they still count while that feed is down.
- Labels say who and when: *"Reported by drivers, 12 min ago, 3 still there"* (*"Reported by a
  driver"* before anyone confirms). Route reasons read *"Rerouted around I-69 Southwest Fwy: crash
  reported (drivers, 5 min ago)"*.
- The Causes tab lists every report under **Reported by drivers** (police and potholes too, which
  never show up as a cause); tap one for its road's Why it's slow, which has a **Reported by
  drivers** card with Still there / Not there.
- A trip that crosses a flooding report (or any flooding incident) gets a **Flooding on your
  route** warning, and police and pothole reports on the route are listed too (they never change a route, so its reasons don't name them).
- A new report, or a vote, re-checks saved trips and watched plans right away (in the background).

## How long it stays up

- **Life:** 45 min for a crash, police or a stalled car; 2 h for a hazard, pothole or flooding.
- **Still there** pushes the end out to a full life from that vote, but never past 4 lives from when
  it was made.
- **Not there:** two more *not there* than *still there* votes take it down. The reporter's own
  *not there* (**Take it down** on the card) withdraws it at once.
- All times are the simulated clock, so the demo's clock jumps age and expire reports too.
- A day after a report ends (expired, voted away or withdrawn) it's deleted with its votes, on the
  next report or vote, so the tables only ever hold about a day of reports.

## Abuse limits

- One vote per client per report. The client is its IP address, stored only as a hash keyed with
  this install's secret (made on first run in `backend/data/reports.key`, gitignored), so a leaked
  database alone doesn't give the addresses back, and votes still match after a restart. Voting
  again changes your vote. The reporter can't confirm their own report.
- Per client, in real time: 6 reports and 30 votes per 10 minutes (429 with `Retry-After`). The
  limiter remembers at most 10,000 clients, and `POST /demo/reset` starts it over (so a rehearsal
  doesn't lock the presenter out of the live demo).
- Kinds are fixed, the point has to be in the Houston area (lat 29.4-30.2, lng -95.9 to -94.9),
  and the optional detail is one line of at most 140 characters.

## API

| Endpoint | |
|---|---|
| `GET /reports` | Reports up right now, newest first: kind, pin position, road, provenance, still there / not there, `affects_routing`, `delay_min`, `outweighed`, `also_on` (flooding: the other direction it floods too) and `mine` (reported / still_there / not_there) for the asking client |
| `GET /reports/snap?lat=&lng=` | Where a report there would go: the road direction and the other direction, or `on_road: false` |
| `POST /reports` | `{kind, lat, lng, note?, segment_id?}`. 201, or 200 with `merged: true` when it counted as a Still there |
| `POST /reports/{id}/vote` | `{still_there: bool}`. `{removed, report}`; 404 once it's no longer up |

## Demo

`POST /demo/scenario/evening` adds four canned reports, labeled **Demo report** (source
`demo_drivers`, "demo drivers" in route reasons), never as real drivers: flooding on Westheimer
into the Galleria (3 still there), a stalled car on the North Fwy, police on SH-288 and a pothole
on Main St that already has one *not there* (one more takes it down). `POST /demo/clear-live`
removes the demo's reports; `POST /demo/reset` removes every report.

## Limits

- Identity is the IP address: drivers behind one address (a venue's Wi-Fi, a proxy) share one vote
  per report and one rate limit.
- There's no heading, so a report from *where I am* on a road picks the direction whose line is
  closer; the sheet shows it and offers the other one.
- Snapping only knows the roads on BlindSpot's own map; reports elsewhere are pins.
