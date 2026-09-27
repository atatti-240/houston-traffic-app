/** Multi-stop plans for the Trip screen, including ones that must arrive by a time. */

import { api } from "@/lib/api";
import { parseSim, toSimIso } from "@/lib/format";
import type { Location, PlanResult, TripPlanRequest } from "@/lib/types";

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

// ---- watched plans already saved ------------------------------------------------------------

/** A place in a plan result ("places", beyond the contract): `node` is the place id for a named place. */
interface PlanPlace {
  node: string;
  lat: number;
  lng: number;
}

/** A saved plan as GET /plan/{id} returns it, with the places it was asked for (in the request's order). */
export type SavedPlan = PlanResult & { places?: { start: PlanPlace; stops: PlanPlace[] } };

function samePlace(p: PlanPlace | undefined, loc: Location): boolean {
  if (!p) return false;
  return typeof loc === "string" ? p.node === loc : Math.abs(p.lat - loc.lat) < 1e-6 && Math.abs(p.lng - loc.lng) < 1e-6;
}

/** The watched plans that are still running. */
export async function watchedPlans(): Promise<SavedPlan[]> {
  const running = (await api.plans()).filter((p) => p.watch && !p.done);
  const plans = await Promise.all(running.map((p) => api.getPlan(p.plan_id).catch(() => null)));
  return plans.filter((p): p is SavedPlan => p !== null);
}

/** Whether a saved plan is the one for these places, deadline ("HH:MM", null = leave now) and safety
 * setting. The extra stops can be in any order: the planner picks the order. */
export function isSamePlan(p: SavedPlan, start: Location, stops: string[], to: Location, by: string | null, safety: number): boolean {
  const pl = p.places;
  if (!pl || pl.stops.length !== stops.length + 1 || Math.abs(p.safety_weight - safety) > 1e-6) return false;
  const end = p.legs[p.legs.length - 1]?.window.end;
  if ((end ? end.slice(11, 16) : null) !== by) return false;
  const extra = pl.stops.slice(0, -1).map((s) => s.node);
  return samePlace(pl.start, start) && samePlace(pl.stops[pl.stops.length - 1], to) && extra.sort().join() === [...stops].sort().join();
}
