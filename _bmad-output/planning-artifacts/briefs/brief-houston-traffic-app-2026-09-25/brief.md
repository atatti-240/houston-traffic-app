---
title: Houston Traffic App — Product Brief
status: draft
created: 2026-09-25
updated: 2026-09-25
---

# Product Brief: Houston Traffic App `[ASSUMPTION: working name]`

_Context: 48-hour hackathon build. Fast-path draft. `[ASSUMPTION]` tags mark things we inferred and still need to confirm._

## Problem Statement

Houston commuters plan their day around traffic they can't see coming. Waze and Google Maps react to congestion after it has formed. They don't warn you that a crash-prone stretch of I-45 is about to get bad, or that a freight train is likely to block your crossing at 7:40. So people leave too late and sit on the highway, or sit at a crossing with no way around it.

## Mission Statement

Tell every Houston commuter **when to leave and which way to go** before the traffic hits. We predict congestion, crash risk and train blockages from the city's own traffic data, not just what's jammed right now.

## The Blind Spot We're Exploiting

Mainstream navigation apps route on live speeds. They have almost no model of:
- **Freight train blockages** at at-grade crossings, which are a Houston-specific pain.
- **Recurring crash risk** by road segment and time of day.
- **Tomorrow's congestion** at a given time on a given road, learned from history.

TranStar data (speeds, travel times from its Bluetooth readers, cameras, incidents) combined with TrainWatch-style train data can cover those gaps. That's the "blind spots" angle from the team's notes. We aren't competing with Google on live traffic. We're doing the prediction they skip. `[ASSUMPTION: this is the core differentiator]`

## The Solution (hackathon version)

A commuter enters a trip and when they need to arrive. The app:
1. **Recommends a departure time** and sends a "leave now" push notification.
2. **Suggests a route** that weighs predicted congestion, crash risk and train-blockage risk. A **Safe Path** toggle leans hard away from crash-prone highways.
3. **Shows why** on a map: congestion scores by segment, risky segments, crossings likely to be blocked, and links to nearby TranStar and train cameras.

### Core model: Congestion Score
- Each **road segment × time bucket** (e.g. 15-minute slot × day of week) gets a congestion score.
- The score is updated daily with an exponential moving average: `score = score + α × (today − score)`, where `α` is the nudge factor.
  - Note: the original idea ("add today's score × nudge factor") keeps growing forever. The moving average version settles on a typical value and still tracks change over time.
- The same pattern is reused for **crossing blockage probability** (per crossing × time bucket) and **crash risk** (per segment × time bucket, based on historical crash counts).

## Who This Serves

- **Primary:** Houston drivers with a fixed arrival time, like a 9-to-5 or a school drop-off, commuting on I-45, I-10, 610, I-69/US-59, Beltway 8, 288 or 290. `[ASSUMPTION]`
- **Secondary:** People who cross freight rail every day (East End, Near Northside and similar areas) for whom one train can wipe out 15 minutes. `[ASSUMPTION]`

## Scope for 48 Hours

**In (demo path):**
- Road/segment database for a handful of major Houston corridors, plus key rail crossings
- Congestion score model (moving average) with synthetic history
- Train-blockage and crash-risk scores (same model shape)
- Routing with a blended cost function and a Safe Path toggle
- Departure-time recommendation plus a simulated push notification
- A map UI that shows scores, the route and camera links

**Out, or faked for the demo:**
- Real computer vision on camera footage (cameras are shown as links or embeds only)
- Live API integrations (mock data sits behind interfaces so real feeds can plug in later)
- A full ML crash-prediction model (heuristic or rate-based scoring instead)
- "Dynamic scheduling" beyond picking a departure time `[ASSUMPTION: this is what dynamic scheduling meant]`

## Success Criteria (for judging)

- Live demo: enter a trip, get a departure time plus a route, and see the train and crash risk reasoning on the map
- Toggling Safe Path visibly changes the route
- Replaying "a week of history" visibly moves the congestion scores
- A clear story on how real TranStar and train feeds would plug in

## Open Questions

- Which one feature is the hero of the demo? The recommendation is **train-aware "leave now" alerts**, since that's the clearest blind spot.
- What's the team's stack and skill set? (The prompts assume FastAPI + SQLite + a Next.js PWA with a Leaflet map.)
- Web or mobile? This affects how push notifications work.
- Product name?
