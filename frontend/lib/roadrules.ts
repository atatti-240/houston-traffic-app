/**
 * Road rules: avoid tolls / highways (a Trip setting, remembered on this device) and the posted
 * speed limits along a route (from OpenStreetMap; null = not known, never guessed).
 */

import type { Route, RouteSegment, SpeedLimitRun } from "./types";

export interface Avoid {
  tolls: boolean;
  highways: boolean;
}

export const NO_AVOID: Avoid = { tolls: false, highways: false };
const STORE_KEY = "blindspot.avoid";

/** The trip link's `avoid` param: "tolls", "highways" or "tolls,highways" ("" = nothing). Undefined without one. */
export function parseAvoid(v: string | null | undefined): Avoid | undefined {
  if (v == null) return undefined;
  const parts = v.split(",");
  return { tolls: parts.includes("tolls"), highways: parts.includes("highways") };
}

/** The `avoid` param for a saved trip's options ("" = nothing avoided). */
export function avoidParam(saved: { avoid_tolls?: boolean; avoid_highways?: boolean }): string {
  return [saved.avoid_tolls && "tolls", saved.avoid_highways && "highways"].filter(Boolean).join(",");
}

/** What this device chose last time (nothing avoided when it never chose, or storage is blocked). */
export function storedAvoid(): Avoid {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null");
    return { tolls: v?.tolls === true, highways: v?.highways === true };
  } catch {
    return NO_AVOID;
  }
}

export function storeAvoid(a: Avoid): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(a));
  } catch {}
}

/** The request fields for /route, /recommend, /plan and /trips. */
export function avoidBody(a: Avoid): { avoid_tolls: boolean; avoid_highways: boolean } {
  return { avoid_tolls: a.tolls, avoid_highways: a.highways };
}

/** Whether a saved trip or plan was saved with these options (older ones avoid nothing). */
export function sameAvoid(saved: { avoid_tolls?: boolean; avoid_highways?: boolean }, a: Avoid): boolean {
  return !!saved.avoid_tolls === a.tolls && !!saved.avoid_highways === a.highways;
}

// ---- speed limits --------------------------------------------------------------------------------

export interface RoadLimit {
  road: string;
  /** Posted limit on the road's longest stretch; null = not known */
  mph: number | null;
  miles: number;
}

/** The roads a route spends the most miles on, longest first (at most `n`), with their limits. */
export function mainRoads(runs: SpeedLimitRun[], n = 2): RoadLimit[] {
  const roads = new Map<string, RoadLimit & { longest: number }>();
  for (const r of runs) {
    const cur = roads.get(r.road);
    if (!cur) roads.set(r.road, { road: r.road, mph: r.speed_limit_mph, miles: r.miles, longest: r.miles });
    else {
      cur.miles += r.miles;
      if (r.miles > cur.longest) Object.assign(cur, { longest: r.miles, mph: r.speed_limit_mph });
    }
  }
  return [...roads.values()]
    .sort((a, b) => b.miles - a.miles)
    .slice(0, n)
    .map(({ road, mph, miles }) => ({ road, mph, miles }));
}

/** The posted limit where you are on a route: the route segment nearest to the point
 * (for a turn-by-turn view). Null for a route without segments. */
export function speedLimitAt(route: Pick<Route, "segments">, lat: number, lng: number): { road: string; mph: number | null } | null {
  const k = Math.cos((lat * Math.PI) / 180);
  let best: RouteSegment | null = null;
  let bestD = Infinity;
  for (const s of route.segments) {
    for (let i = 1; i < s.geometry.length; i++) {
      const [ay, ax] = s.geometry[i - 1];
      const [by, bx] = s.geometry[i];
      const dx = (bx - ax) * k;
      const dy = by - ay;
      const len = dx * dx + dy * dy;
      const t = len ? Math.max(0, Math.min(1, (((lng - ax) * k) * dx + (lat - ay) * dy) / len)) : 0;
      const d = ((lng - ax) * k - t * dx) ** 2 + (lat - ay - t * dy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
  }
  return best ? { road: best.name, mph: best.speed_limit_mph ?? null } : null;
}
