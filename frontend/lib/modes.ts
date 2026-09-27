/** Walk, bike and transit: the Trip screen's other tabs. Types and client for /travel/route and
 * /transit/*, plus what they draw on the map. */

import { API_URL } from "@/lib/api";
import { CAUSE, ICON } from "@/lib/theme";
import type { LatLngTuple } from "@/lib/types";

/** The Trip screen's tabs other than Drive (Drive is the screen without one). */
export type Travel = "walk" | "bike" | "transit";
export const TRAVELS: Travel[] = ["walk", "bike", "transit"];

export function parseTravel(v: string | null | undefined): Travel | undefined {
  return TRAVELS.find((t) => t === v);
}

export interface LatLng {
  lat: number;
  lng: number;
}

// ---- walk / bike ----------------------------------------------------------------------------------

export interface TravelStep {
  instruction: string;
  name: string;
  /** OSRM maneuver: depart, turn, arrive, roundabout ... */
  type: string;
  /** left, slight right, straight, uturn ... */
  modifier: string | null;
  distance_m: number;
  duration_s: number;
  at: LatLngTuple;
}

export interface WalkBikeRoute {
  mode: "walk" | "bike";
  distance_m: number;
  duration_s: number;
  depart_at: string;
  arrive_at: string;
  geometry: LatLngTuple[];
  steps: TravelStep[];
  source: string;
}

// ---- transit --------------------------------------------------------------------------------------

export interface TransitStop {
  id: string;
  code: string | null;
  name: string;
  lat: number;
  lng: number;
}

export interface TransitRoute {
  id: string;
  /** "82 Westheimer", "Red Line" */
  name: string;
  short_name: string;
  long_name: string;
  mode: "bus" | "rail" | "transit";
  color: string | null;
  text_color: string | null;
}

export interface TransitWalk {
  kind: "walk";
  /** null: from the start */
  from: TransitStop | null;
  /** null: to the destination */
  to: TransitStop | null;
  minutes: number;
  meters: number;
  geometry: LatLngTuple[];
}

export interface TransitRide {
  kind: "ride";
  route: TransitRoute;
  headsign: string;
  from: TransitStop;
  to: TransitStop;
  depart_at: string;
  arrive_at: string;
  minutes: number;
  /** stops ridden */
  stops: number;
  geometry: LatLngTuple[];
}

export type TransitLeg = TransitWalk | TransitRide;

export interface TransitOption {
  leave_at: string;
  arrive_at: string;
  minutes: number;
  walk_min: number;
  changes: number;
  legs: TransitLeg[];
  /** Later departures of the first ride from the same stop */
  later: string[];
}

export interface TransitNearby {
  stop: TransitStop;
  walk_min: number;
  departures: { route: TransitRoute; headsign: string; at: string }[];
}

export type TransitStatus = "ok" | "not_loaded" | "outside_dates" | "no_service" | "no_stops_start" | "no_stops_end" | "no_trips";

export interface TransitFeed {
  agency: string | null;
  version: string | null;
  start_date: string | null;
  end_date: string | null;
  stops: number;
  routes: number;
  trips: number;
  built_at: string | null;
}

export interface TransitPlan {
  status: TransitStatus;
  /** Why there are no options (null when status is "ok") */
  message: string | null;
  depart_at: string;
  options: TransitOption[];
  nearby: TransitNearby[];
  /** Walking the whole way, estimated */
  walk_only_min: number | null;
  feed: TransitFeed | null;
  /** METRO's required attribution */
  legend: string;
}

/** A request that failed. `retry`: asking again may help (BlindSpot or the routing service was down,
 * slow or busy); not for a trip that's outside the area, too far or has no route. */
export class TravelError extends Error {
  retry: boolean;
  constructor(message: string, retry: boolean) {
    super(message);
    this.retry = retry;
  }
}

async function send<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new TravelError("Can't reach BlindSpot right now.", true);
  }
  if (!res.ok) {
    let detail: unknown;
    try {
      detail = (await res.json()).detail;
    } catch {}
    // 4xx (422 outside the area or too far, 404 no route) says the same next time; 5xx may not.
    const retry = res.status >= 500 || res.status === 408 || res.status === 429;
    throw new TravelError(typeof detail === "string" ? detail : "Something went wrong.", retry);
  }
  return res.json();
}

export const travelApi = {
  walkBike: (body: { mode: "walk" | "bike"; origin: LatLng; destination: LatLng; depart_at?: string }) =>
    send<WalkBikeRoute>("/travel/route", body),
  transitTrip: (body: { origin: LatLng; destination: LatLng; depart_at?: string }) => send<TransitPlan>("/transit/trip", body),
};

// ---- map --------------------------------------------------------------------------------------------

/** A walk (dotted), a bike ride or a bus / train ride, drawn over the traffic map. */
export interface ModeLine {
  kind: "walk" | "bike" | "ride";
  positions: LatLngTuple[];
}

/** What the Walk / Bike / Transit tabs put in the map scene. */
export interface ModeRoute {
  lines: ModeLine[];
  /** Stops to get on and off at */
  stops?: { lat: number; lng: number; label: string }[];
}

export const MODE_COLOR = {
  walk: "#ECEDEF",
  bike: "#5EE0C8",
  ride: "#8FB0FF",
} as const;

// ---- icons and words -------------------------------------------------------------------------------

/** 24x24 stroke paths, like ICON in lib/theme. */
export const MODE_ICON = {
  drive: ICON.car,
  walk: "M13.5 3.2a1.6 1.6 0 1 0 0 3.2a1.6 1.6 0 1 0 0-3.2zM12.5 8.5l-2 5.5 3 3 1 4.5M10.5 14l-2.5 7M12.5 8.5l-4 2.5-1 3M12.5 8.5l2 3.5 3 1",
  bike: "M6 13.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7zM18 13.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7zM6 17l3.5-7h6L18 17M9.5 10L12 17h-6M15 6.5h2.5l-2 3.5M8 7h3",
  transit: "M7 3h10a2 2 0 0 1 2 2v12H5V5a2 2 0 0 1 2-2zM5 11h14M5 7h14M8 17v3M16 17v3M8.5 14h.01M15.5 14h.01",
  rail: CAUSE.train.icon,
} as const;

/** A turn arrow for a step. */
export function stepIcon(s: Pick<TravelStep, "type" | "modifier">): string {
  if (s.type === "arrive") return ICON.pin;
  if (s.type === "depart") return "M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z";
  const m = s.modifier ?? "";
  if (m === "uturn") return "M16 20V10a4 4 0 0 0-8 0v10M4 16l4 4 4-4";
  if (m.endsWith("left")) return "M19 20v-7a4 4 0 0 0-4-4H5M9 5L5 9l4 4";
  if (m.endsWith("right")) return "M5 20v-7a4 4 0 0 1 4-4h10M15 5l4 4-4 4";
  return "M12 20V4M7 9l5-5 5 5";
}

/** US units: "400 ft", "1.8 mi". */
export function fmtDistance(meters: number): string {
  const mi = meters / 1609.344;
  if (mi < 0.1) return `${Math.max(50, Math.round((meters * 3.28084) / 50) * 50)} ft`;
  return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
}

/** "38 min", "1 h 5 min" */
export function fmtMinutes(min: number): string {
  const m = Math.max(1, Math.round(min));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}
