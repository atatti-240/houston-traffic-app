/**
 * When to re-plan from where you are:
 *  - off the route: more than OFF_ROUTE_M from the line (or the fix's accuracy, if worse) for OFF_ROUTE_MS, and
 *    still that far at the end of it, judged only on fixes good enough to tell (accuracy within MAX_ACCURACY_M).
 *    Coming back within BACK_ON_M resets it; in between it holds (so wobbling around 50 m neither triggers nor
 *    clears it by itself).
 *  - going the wrong way along the route (a U-turn) for OFF_ROUTE_MS.
 *  - a heavy slowdown that wasn't there when the route was planned shows up on a road still ahead.
 * Not within NEAR_END_M of the destination (as the crow flies: missing the last turn still re-plans).
 * And how often: one re-plan at a time, none within COOLDOWN_MS of the last one, longer after failures (the
 * directions service is shared and rate limited), never sooner than the server asked. A run of failures ends once
 * you're back on the route, so the next stretch off it is said again.
 * No framework imports (unit-tested with `node --test`).
 */

import type { CourseSegment } from "./course.ts";
import { angleDiff } from "./geo.ts";

export const OFF_ROUTE_M = 50;
export const BACK_ON_M = 35;
export const OFF_ROUTE_MS = 4000;
export const MAX_ACCURACY_M = 100;
/** A fix older than this says nothing about now */
export const STALE_FIX_MS = 15_000;
export const COOLDOWN_MS = 30_000;
/** Waits after 1, 2, 3+ failures in a row */
export const BACKOFF_MS = [15_000, 30_000, 60_000];
/** A slowdown must start at least this far ahead to be worth a re-plan */
export const SLOWDOWN_AHEAD_M = 300;
/** ... or, on the road you're already on, this much of it must be left (a way off it before the slowdown) */
export const SLOWDOWN_LEFT_M = 1500;
/** Within this of the destination (straight line) there's nothing to re-plan */
export const NEAR_END_M = 150;

/** Nothing to re-plan this close to the destination. `toEnd`: straight-line meters to it (not along the route: a
 * fix far from the route can fall on the line's last meters). */
export const nearEnd = (toEnd: number) => toEnd <= NEAR_END_M;

export interface OffRoute {
  /** When the current stretch off the route began (null: on it) */
  since: number | null;
  /** The last fix that could tell */
  lastAt: number | null;
  /** The last fix that was over the limit */
  lastOver: number | null;
}

export const onRoute = (): OffRoute => ({ since: null, lastAt: null, lastOver: null });

/** Update with a fix `off` meters from the line, `accuracy` meters (radius), taken at `at` (ms). */
export function trackOffRoute(s: OffRoute, off: number, accuracy: number | null | undefined, at: number): OffRoute {
  const acc = accuracy ?? 0;
  if (Number.isNaN(off)) return s;
  if (acc > MAX_ACCURACY_M) return s; // can't tell
  const limit = Math.max(OFF_ROUTE_M, acc);
  if (off > limit) return { since: s.since ?? at, lastAt: at, lastOver: at };
  if (off < BACK_ON_M) return { since: null, lastAt: at, lastOver: null };
  return { ...s, lastAt: at };
}

/** Off the route long enough to re-plan, going by fixes that are still current: over the limit for the whole
 * stretch, or still over it now (one stray fix over 50 m, then fixes 40 m off, isn't "off the route"). */
export function isOffRoute(s: OffRoute, now: number): boolean {
  if (s.since === null || s.lastAt === null || s.lastOver === null) return false;
  const still = s.lastOver === s.lastAt || s.lastOver - s.since >= OFF_ROUTE_MS;
  return still && now - s.since >= OFF_ROUTE_MS && now - s.lastAt <= STALE_FIX_MS;
}

// ---- going the wrong way ------------------------------------------------------------------------------

/** Heading this far from the road's (degrees) is going back along it; within FORWARD_DEG is going the right way */
export const WRONG_WAY_DEG = 120;
const FORWARD_DEG = 60;
/** Slower than this (m/s) the heading says nothing */
const MOVING_MPS = 3;
/** Without a heading: this far back along the route from the farthest you got */
const BACKWARDS_M = 50;

export interface WrongWay {
  since: number | null;
  lastAt: number | null;
  /** Farthest along the route so far */
  best: number;
}

export const goingForward = (): WrongWay => ({ since: null, lastAt: null, best: -Infinity });

/** Update with a fix on the route: your heading and speed, where you are along it and the road's heading there. */
export function trackWrongWay(
  s: WrongWay,
  f: { heading: number | null; speed: number | null; along: number; roadHeading: number; at: number },
): WrongWay {
  const best = Math.max(s.best, f.along);
  const moving = (f.speed ?? MOVING_MPS) >= MOVING_MPS;
  let back: boolean | null = null;
  if (moving && f.heading !== null) {
    const d = angleDiff(f.heading, f.roadHeading);
    back = d > WRONG_WAY_DEG ? true : d < FORWARD_DEG ? false : null;
  } else if (moving) back = best - f.along > BACKWARDS_M ? true : f.along >= best - 5 ? false : null;
  if (back === true) return { since: s.since ?? f.at, lastAt: f.at, best };
  if (back === false) return { since: null, lastAt: f.at, best };
  return { ...s, best };
}

/** Going the wrong way for OFF_ROUTE_MS, going by fixes that are still current. */
export function isWrongWay(s: WrongWay, now: number): boolean {
  return s.since !== null && s.lastAt !== null && s.lastAt - s.since >= OFF_ROUTE_MS && now - s.lastAt <= STALE_FIX_MS;
}

export interface Gate {
  busy: boolean;
  failures: number;
  /** No re-plan before this (ms) */
  notBefore: number;
}

export const openGate = (): Gate => ({ busy: false, failures: 0, notBefore: 0 });

export const canReroute = (g: Gate, now: number) => !g.busy && now >= g.notBefore;

export const started = (g: Gate): Gate => ({ ...g, busy: true });

export const succeeded = (g: Gate, now: number): Gate => ({ busy: false, failures: 0, notBefore: now + COOLDOWN_MS });

/** Back on the route: a run of failures is over (the next stretch off it is said again); the wait stays. */
export const recovered = (g: Gate): Gate => (g.busy || g.failures === 0 ? g : { ...g, failures: 0 });

/** A failed re-plan: wait longer each time in a row, and at least as long as the server said (`retryAfterS`). */
export function failed(g: Gate, now: number, retryAfterS: number | null = null): Gate {
  const failures = g.failures + 1;
  const wait = Math.max(BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1], (retryAfterS ?? 0) * 1000);
  return { busy: false, failures, notBefore: now + wait };
}

/**
 * The first road still ahead (starting at least SLOWDOWN_AHEAD_M ahead, or the one you're on with at least
 * SLOWDOWN_LEFT_M of it left: its slowdown can be anywhere along it) with heavy traffic that wasn't counted before (`seen`: heavy when the route was planned, or already acted on).
 * `heavy`: segment ids with heavy traffic now.
 */
export function newHeavyAhead(
  segments: CourseSegment[],
  along: number,
  heavy: ReadonlySet<string>,
  seen: ReadonlySet<string>,
): CourseSegment | null {
  for (const s of segments) {
    const on = s.from <= along && along < s.to;
    if (on ? s.to - along < SLOWDOWN_LEFT_M : s.from < along + SLOWDOWN_AHEAD_M) continue;
    if (heavy.has(s.id) && !seen.has(s.id)) return s;
  }
  return null;
}

/** A congestion score this high moves at under half of free-flow speed (backend: speed = 1 - 0.85 * score), which
 * is what the slowdowns list calls heavy. */
export const HEAVY_SCORE = 0.59;

/** Road segments a route was planned knowing they'd be heavy when you got there (the planner's own traffic, live
 * or predicted for that time, or an incident or closure on them): turning heavy on schedule isn't news. */
export function plannedHeavy(
  segments: { id: string; congestion: number; predicted_congestion: number; incident: unknown; closure: unknown }[],
): Set<string> {
  const out = new Set<string>();
  for (const s of segments) {
    if (Math.max(s.congestion, s.predicted_congestion) >= HEAVY_SCORE || s.incident || s.closure) out.add(s.id);
  }
  return out;
}
