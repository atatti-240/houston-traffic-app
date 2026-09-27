/**
 * When to re-plan from where you are:
 *  - off the route: more than OFF_ROUTE_M from the line (or the fix's accuracy, if worse) for OFF_ROUTE_MS, judged
 *    only on fixes good enough to tell (accuracy within MAX_ACCURACY_M). Coming back within BACK_ON_M resets it; in
 *    between it holds (so wobbling around 50 m neither triggers nor clears it by itself).
 *  - a heavy slowdown that wasn't there when the route was planned shows up on a road still ahead.
 * And how often: one re-plan at a time, none within COOLDOWN_MS of the last one, longer after failures (the
 * directions service is shared and rate limited), never sooner than the server asked.
 * No framework imports (unit-tested with `node --test`).
 */

import type { CourseSegment } from "./course.ts";

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
/** Within this of the destination there's nothing to re-plan */
export const NEAR_END_M = 150;

export interface OffRoute {
  /** When the current stretch off the route began (null: on it) */
  since: number | null;
  /** The last fix that could tell */
  lastAt: number | null;
}

export const onRoute = (): OffRoute => ({ since: null, lastAt: null });

/** Update with a fix `off` meters from the line, `accuracy` meters (radius), taken at `at` (ms). */
export function trackOffRoute(s: OffRoute, off: number, accuracy: number | null | undefined, at: number): OffRoute {
  const acc = accuracy ?? 0;
  if (Number.isNaN(off)) return s;
  if (acc > MAX_ACCURACY_M) return s; // can't tell
  const limit = Math.max(OFF_ROUTE_M, acc);
  if (off > limit) return { since: s.since ?? at, lastAt: at };
  if (off < BACK_ON_M) return { since: null, lastAt: at };
  return { ...s, lastAt: at };
}

/** Off the route long enough to re-plan, going by fixes that are still current. */
export function isOffRoute(s: OffRoute, now: number): boolean {
  return s.since !== null && s.lastAt !== null && now - s.since >= OFF_ROUTE_MS && now - s.lastAt <= STALE_FIX_MS;
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

/** A failed re-plan: wait longer each time in a row, and at least as long as the server said (`retryAfterS`). */
export function failed(g: Gate, now: number, retryAfterS: number | null = null): Gate {
  const failures = g.failures + 1;
  const wait = Math.max(BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1], (retryAfterS ?? 0) * 1000);
  return { busy: false, failures, notBefore: now + wait };
}

/**
 * The first road still ahead (starting at least SLOWDOWN_AHEAD_M ahead) with heavy traffic that wasn't counted
 * before (`seen`: heavy when the route was planned, or already acted on). `heavy`: segment ids with heavy traffic now.
 */
export function newHeavyAhead(
  segments: CourseSegment[],
  along: number,
  heavy: ReadonlySet<string>,
  seen: ReadonlySet<string>,
): CourseSegment | null {
  for (const s of segments) {
    if (s.from < along + SLOWDOWN_AHEAD_M) continue;
    if (heavy.has(s.id) && !seen.has(s.id)) return s;
  }
  return null;
}
