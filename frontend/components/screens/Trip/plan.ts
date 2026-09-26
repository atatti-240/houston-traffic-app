/** Multi-stop plans for the Trip screen, including ones that must arrive by a time. */

import { api } from "@/lib/api";
import { parseSim, toSimIso } from "@/lib/format";
import type { PlanResult, TripPlanRequest } from "@/lib/types";

const MIN = 60_000;
const STEP = 5 * MIN;
/** Aim to arrive this long before the deadline, on top of the plan's own buffer. */
const MARGIN = 5 * MIN;
/** Close enough: arriving no more than this much earlier than aimed for. */
const CLOSE = 15 * MIN;
const TRIES = 3;

export interface TimedPlan {
  plan: PlanResult;
  /** The depart_after that produced the plan (ISO, simulated time), when it isn't "now". */
  departAfter?: string;
  /** The destination's deadline as the backend resolved it (ISO), when there is one. */
  deadline?: string;
}

const ms = (iso: string) => parseSim(iso).getTime();
const firstLeave = (p: PlanResult) => ms(p.legs[0].leave_at);
const lastArrive = (p: PlanResult) => ms(p.legs[p.legs.length - 1].arrive_at);
const onTime = (p: PlanResult) => p.status === "ok" && !p.legs.some((l) => l.tight || l.late_min > 0);

/** The request with the last stop's deadline set to an absolute time (so it can't roll to another day). */
export function withDeadline(body: TripPlanRequest, deadline: string | undefined): TripPlanRequest {
  if (!deadline) return body;
  const last = body.stops.length - 1;
  return { ...body, stops: body.stops.map((s, i) => (i === last ? { ...s, window_end: deadline } : s)) };
}

/**
 * The planner leaves as early as it can when only the last stop has a deadline, so "arrive by
 * 8:00 AM" asked at 5 PM would plan a drive right now. Start later instead: move the departure
 * by how early the plan gets there (a few tries, since traffic is different by then) and keep
 * the latest plan that is still on time. Without a deadline this is one plain /plan call.
 */
export async function planTrip(body: TripPlanRequest): Promise<TimedPlan> {
  const first = await api.plan(body);
  const deadline = first.legs[first.legs.length - 1]?.window.end ?? undefined;
  if (!deadline || !first.legs.length || !onTime(first)) return { plan: first, deadline };

  const target = ms(deadline) - first.buffer_min * MIN - MARGIN;
  const fixed = withDeadline(body, deadline);
  let best: TimedPlan = { plan: first, deadline };
  let dep = firstLeave(first);
  let arrive = lastArrive(first);
  for (let i = 0; i < TRIES; i++) {
    const gap = target - arrive;
    if (gap >= 0 && gap < CLOSE) break;
    const next = dep + Math.floor(gap / STEP) * STEP;
    if (next <= firstLeave(best.plan)) break; // nothing later than what we already have
    const departAfter = toSimIso(new Date(next));
    const p = await api.plan({ ...fixed, depart_after: departAfter });
    if (!p.legs.length) break;
    if (onTime(p) && firstLeave(p) > firstLeave(best.plan)) best = { plan: p, departAfter, deadline };
    dep = firstLeave(p);
    arrive = lastArrive(p);
  }
  return best;
}
