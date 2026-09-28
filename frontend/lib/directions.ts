/** Route choices and door-to-door directions: API calls, and the words and arrows for them. */

import { API_URL, post } from "./api";
import type { Location, Recommendation, Route, RouteDirections, RouteStep } from "./types";

// ---- API ---------------------------------------------------------------------------------------

export interface RouteChoices {
  best: Route;
  alternative: Route | null;
  /** Up to 3 routes, best first */
  routes?: Route[];
}

/** Leave now, with up to 3 routes and door-to-door directions (the first route's right away, the others
 * from the cache or "pending"). */
type AvoidFields = { avoid_tolls?: boolean; avoid_highways?: boolean };

export const routeChoices = (
  body: { origin: Location; destination: Location; depart_at?: string; safe_path?: boolean; safety_weight?: number } & AvoidFields,
) =>
  post<RouteChoices>("/route?directions=true", body);

export const recommendChoices = (
  body: { origin: Location; destination: Location; arrive_by: string; safe_path?: boolean; safety_weight?: number } & AvoidFields,
) =>
  post<Recommendation>("/recommend?directions=true", body);

/** What a route's directions change in it (for one that came back "pending"). */
export type DirectionsPatch = Pick<Route, "geometry" | "depart_at" | "arrive_at" | "total_min" | "breakdown"> & {
  id: string;
  directions: RouteDirections;
};

/** POST /directions didn't answer. `retryAfterS`: worth asking again after about that long (too many asks, a
 * server or network hiccup); null: asking again won't help (a route the server doesn't know). */
export class DirectionsError extends Error {
  constructor(
    message: string,
    readonly retryAfterS: number | null,
  ) {
    super(message);
  }
}

export async function routeDirections(body: { origin: Location; destination: Location; segment_ids: string[]; depart_at?: string }) {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/directions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new DirectionsError("Can't reach the server", 0);
  }
  if (res.ok) return (await res.json()) as DirectionsPatch;
  const err = (await res.json().catch(() => ({}))) as { detail?: unknown; retry_after_s?: unknown };
  const detail = typeof err.detail === "string" ? err.detail : res.statusText;
  // 429: this device asked too often (the router is shared); try again when the server says
  const again = res.status === 429 || res.status >= 500;
  throw new DirectionsError(detail, again ? Math.max(0, Number(err.retry_after_s) || 0) : null);
}

// ---- words -------------------------------------------------------------------------------------

/** "450 ft", "2.4 mi", "12 mi" */
export function fmtDistance(m: number): string {
  const mi = m / 1609.344;
  if (mi < 0.1) return `${Math.max(50, Math.round((m * 3.28084) / 50) * 50)} ft`;
  return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
}

const INCIDENT_NOUN: Record<string, string> = {
  crash: "the crash",
  stall: "the stalled vehicle",
  hazard: "the hazard",
  roadwork: "the roadwork",
  lane_closure: "the lane closure",
  closure: "the closure",
  event: "the event traffic",
  weather: "the bad weather",
};

/** What a route skips that another one has, in a few words ("skips the train crossing at Cullen Blvd"). */
function upsides(route: Route, other: Route): string[] {
  const out: string[] = [];
  const crossings = new Set(route.crossings.map((c) => c.id));
  for (const c of other.crossings) {
    if (!crossings.has(c.id) && (c.expected_delay_min >= 1 || c.block_probability >= 0.25))
      out.push(`skips the train crossing at ${c.name.split(" @ ")[0]}`);
  }
  const hazards = new Set(route.hazards.map((h) => `${h.type}|${h.name}`));
  for (const h of other.hazards) {
    if ((h.type === "incident" || h.type === "closure") && !hazards.has(`${h.type}|${h.name}`))
      out.push(`avoids ${INCIDENT_NOUN[h.type === "closure" ? "closure" : String(h.kind)] ?? "the incident"} on ${h.road}`);
  }
  // Slow roads the other route is on (not the one it's named after: "slower than via X, avoids X" says nothing)
  const roads = new Set(route.segments.map((s) => s.name));
  const named = other.label?.replace(/^via /, "") ?? "";
  for (const c of other.delay_causes ?? []) {
    if ((c.kind === "rush" || c.kind === "volume") && c.minutes >= 3 && !roads.has(c.road) && !(named && c.road.startsWith(named)))
      out.push(`avoids the slow traffic on ${c.road}`);
  }
  const a = route.breakdown.crash_exposure;
  const b = other.breakdown.crash_exposure;
  if (b > 0 && a <= b * 0.75) out.push("has less crash risk");
  return [...new Set(out)];
}

/** A route's time as the app shows it: whole minutes, at least 1. */
export const shownMinutes = (r: Route) => Math.max(1, Math.round(r.total_min));

/**
 * "Why this way", compared with each other route: "4 min faster than via I-610 and skips the train crossing at
 * Cullen Blvd", "3 min slower than via I-45, but avoids the crash on I-45 Gulf Fwy". `roughTimes`: routes whose
 * times aren't door to door (their directions are on the way, or unavailable), so no minutes are compared for them.
 */
export function compareRoutes(route: Route, others: Route[], roughTimes: (r: Route) => boolean = () => false): string[] {
  const out: string[] = [];
  for (const o of others) {
    const label = o.label ?? `via ${o.summary}`;
    const tail = upsides(route, o)[0] ?? "";
    if (roughTimes(route) || roughTimes(o)) {
      if (tail) out.push(`Unlike ${label}, ${tail}`);
      continue;
    }
    // From the whole minutes the list and the map show (19.4 vs 20.5 reads "19" vs "21": 2 min, not 1)
    const diff = shownMinutes(o) - shownMinutes(route);
    if (diff >= 1) out.push(`${diff} min faster than ${label}${tail ? ` and ${tail}` : ""}`);
    else if (diff <= -1) out.push(`${-diff} min slower than ${label}${tail ? `, but ${tail}` : ""}`);
    else out.push(`About as fast as ${label}${tail ? `, and ${tail}` : ""}`);
  }
  return out;
}

/** "Use the right 2 lanes" (for screen readers; the arrows show it). */
export function lanesText(lanes: { valid: boolean }[]): string {
  const ok = lanes.map((l, i) => (l.valid ? i : -1)).filter((i) => i >= 0);
  if (!ok.length) return "";
  const n = ok.length;
  const word = n === 1 ? "lane" : `${n} lanes`;
  const contiguous = ok[n - 1] - ok[0] === n - 1;
  if (contiguous && ok[0] === 0) return `Use the left ${word}`;
  if (contiguous && ok[n - 1] === lanes.length - 1) return `Use the right ${word}`;
  return `Use lane${n > 1 ? "s" : ""} ${ok.map((i) => i + 1).join(", ")} of ${lanes.length}`;
}

// ---- arrows (24x24 stroke paths, like ICON in lib/theme) ------------------------------------------

const ARROW: Record<string, string> = {
  straight: "M12 20V5M7 10l5-5 5 5",
  left: "M17 20v-7a3 3 0 0 0-3-3H6M10 6l-4 4 4 4",
  right: "M7 20v-7a3 3 0 0 1 3-3h8M14 6l4 4-4 4",
  "slight left": "M15 20v-5.5L8.5 8M8 13.5V8h5.5",
  "slight right": "M9 20v-5.5L15.5 8M16 13.5V8h-5.5",
  "sharp left": "M15 4v11l-7 5M8 14.5V20h5.5",
  "sharp right": "M9 4v11l7 5M16 14.5V20h-5.5",
  uturn: "M16 20V10a4 4 0 0 0-8 0v7M4 14l4 4 4-4",
};
const DEPART = "M12 17V5M7 10l5-5 5 5M12 21.5a1.5 1.5 0 1 0 0-3a1.5 1.5 0 1 0 0 3z";
const ARRIVE = "M12 21s-6-5.3-6-11a6 6 0 1 1 12 0c0 5.7-6 11-6 11zM12 7.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5z";
const ROUNDABOUT = "M12 20v-4.5M9 12.5a3.5 3.5 0 1 1 5.5 2.8M14 8.5V4M12 6l2-2 2 2";

/** The arrow for a step's maneuver. */
export function maneuverIcon(step: RouteStep): string {
  const { type, modifier } = step.maneuver;
  if (type === "depart") return DEPART;
  if (type === "arrive") return ARRIVE;
  if (type === "roundabout" || type === "rotary" || type === "roundabout turn") return ROUNDABOUT;
  return ARROW[modifier ?? "straight"] ?? ARROW.straight;
}

/** The arrow(s) painted on a lane ("none" = no marking: straight on). */
export function laneIcons(indications: string[]): string[] {
  return indications.map((i) => ARROW[i === "merge to left" ? "slight left" : i === "merge to right" ? "slight right" : i] ?? ARROW.straight);
}
