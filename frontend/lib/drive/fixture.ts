/**
 * A small made-up route for the driving-mode unit tests: 2 km east on Main St, a left turn, 1.5 km north on
 * North St (a rail crossing 500 m up it, a crash on it), then the destination on the right.
 */

import type { Route, RouteSegment, RouteStep } from "../types";
import { offset, type Pt } from "./geo.ts";

export const START: Pt = [29.76, -95.4];
/** Where the left turn is */
export const CORNER: Pt = offset(START, 90, 2000);
export const END: Pt = offset(CORNER, 0, 1500);

/** Points every `every` meters from a to `meters` away toward `heading`. */
function leg(a: Pt, heading: number, meters: number, every = 100): Pt[] {
  const out: Pt[] = [];
  for (let d = every; d <= meters + 1e-6; d += every) out.push(offset(a, heading, d));
  return out;
}

function step(instruction: string, type: string, modifier: string | null, location: Pt, distance_m: number, duration_s: number, road: string): RouteStep {
  return {
    instruction,
    distance_m,
    duration_s,
    maneuver: { type, modifier, location, bearing_before: 0, bearing_after: 0, exit: null },
    road,
  };
}

function segment(id: string, name: string, geometry: Pt[], extra: Partial<RouteSegment> = {}): RouteSegment {
  return {
    id,
    name,
    road_class: "arterial",
    enter_at: "2026-09-28T07:15:00",
    travel_min: 3,
    train_delay_min: 0,
    congestion: 0.2,
    predicted_congestion: 0.2,
    congestion_source: "history",
    live_weight: 0,
    live_updated_at: null,
    incident: null,
    incident_slowdown: 0,
    closure: null,
    closure_wait_min: 0,
    confidence: "high",
    crash_risk: 0.1,
    miles: 1,
    geometry,
    ...extra,
  };
}

/** The test route. `withSteps: false` gives one without turn-by-turn (directions unavailable). */
export function testRoute({ withSteps = true, totalMin = 6 } = {}): Route {
  const east = [START, ...leg(START, 90, 2000)];
  const north = [CORNER, ...leg(CORNER, 0, 1500)];
  const geometry = [...east, ...north.slice(1)];
  const crossing = offset(CORNER, 0, 500);
  const steps: RouteStep[] = [
    step("Head east on Main St", "depart", null, START, 2000, 150, "Main St"),
    { ...step("Turn left onto North St", "turn", "left", CORNER, 1500, 120, "North St"), lanes: [{ valid: true, indications: ["left"] }, { valid: false, indications: ["straight"] }] },
    step("Arrive at your destination, on the right", "arrive", "right", END, 0, 0, ""),
  ];
  return {
    origin: "a",
    destination: "b",
    depart_at: "2026-09-28T07:15:00",
    arrive_at: "2026-09-28T07:21:00",
    total_min: totalMin,
    safe_path: false,
    safety_weight: 0,
    confidence: "high",
    feeds_down: [],
    summary: "Main St → North St",
    breakdown: { free_flow_min: 5, base_travel_min: 6, train_delay_min: 0, closure_wait_min: 0, crash_exposure: 0, max_crash_risk: 0, max_block_probability: 0.4 },
    reasons: [],
    hazards: [],
    geometry,
    segments: [
      segment("S1", "Main St", east, { speed_limit_mph: 45 }),
      segment("S2", "North St", north, {
        incident: {
          id: "inc1",
          title: "Crash",
          kind: "crash",
          segment_id: "S2",
          started_at: "2026-09-28T07:00:00",
          clears_at: null,
          lanes_blocked: 1,
          source: "houston_transtar",
          updated_at: "2026-09-28T07:00:00",
          detail: "",
        },
      }),
    ],
    crossings: [
      {
        id: "x1",
        name: "North St @ UP",
        lat: crossing[0],
        lng: crossing[1],
        arrive_at: "2026-09-28T07:19:00",
        block_probability: 0.4,
        expected_delay_min: 1,
        live: false,
        sensor: null,
        confidence: "medium",
        source: "history",
        updated_at: null,
      },
    ],
    id: "r1",
    directions: withSteps
      ? { status: "ok", steps, distance_m: 3500, access_min: null, note: null }
      : { status: "unavailable", steps: [], distance_m: null, access_min: null, note: "Turn-by-turn directions aren't available right now." },
  };
}
