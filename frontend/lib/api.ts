import type {
  AppNotification,
  Camera,
  ClockState,
  Crossing,
  LiveConditions,
  Location,
  Place,
  PlanResult,
  Recommendation,
  Route,
  ScoreMap,
  Segment,
  Trip,
  TripPlanRequest,
} from "./types";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {}
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

const post = <T,>(path: string, body?: unknown) =>
  call<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const at = (when?: string) => (when ? `?at=${encodeURIComponent(when)}` : "");

export const api = {
  places: () => call<Place[]>("/places"),
  segments: () => call<Segment[]>("/segments"),
  congestion: (when?: string) => call<ScoreMap>(`/scores/congestion${at(when)}`),
  crashRisk: (when?: string) => call<ScoreMap>(`/scores/crash-risk${at(when)}`),
  crossings: (when?: string) => call<{ at: string; crossings: Crossing[] }>(`/crossings${at(when)}`),
  cameras: () => call<Camera[]>("/cameras"),
  route: (body: { origin: Location; destination: Location; depart_at?: string; safe_path?: boolean; safety_weight?: number }) =>
    post<{ best: Route; alternative: Route | null }>("/route", body),
  recommend: (body: {
    origin: Location;
    destination: Location;
    arrive_by: string;
    safe_path?: boolean;
    safety_weight?: number;
  }) => post<Recommendation>("/recommend", body),
  live: () => call<LiveConditions>("/live"),
  plan: (body: TripPlanRequest) => post<PlanResult>("/plan", body),
  getPlan: (id: string) => call<PlanResult>(`/plan/${encodeURIComponent(id)}`),
  deletePlan: (id: string) => call<void>(`/plan/${encodeURIComponent(id)}`, { method: "DELETE" }),
  trips: () => call<Trip[]>("/trips"),
  createTrip: (body: Omit<Trip, "id">) => post<Trip>("/trips", body),
  deleteTrip: (id: number) => call<void>(`/trips/${id}`, { method: "DELETE" }),
  notifications: (sinceId = 0) => call<AppNotification[]>(`/notifications?since_id=${sinceId}`),
  clock: () => call<ClockState>("/clock"),
  advanceClock: (body: { minutes?: number; to?: string }) => post<ClockState>("/demo/advance-clock", body),
  blockCrossing: (crossing_id: string, minutes: number) =>
    post<{ notifications: AppNotification[] }>("/demo/block-crossing", { crossing_id, minutes }),
  clearBlockages: () => post<{ ok: boolean }>("/demo/clear-blockages"),
  liveTraffic: (body: { segment_ids: string[]; congestion: number; source?: string; detail?: string }) =>
    post<{ notifications: AppNotification[] }>("/demo/live-traffic", body),
  incident: (body: { segment_id: string; kind?: string; title?: string; minutes?: number | null; lanes_blocked?: number }) =>
    post<{ notifications: AppNotification[] }>("/demo/incident", body),
  crossingSensor: (crossing_id: string, up: boolean) =>
    post<{ notifications: AppNotification[] }>("/demo/crossing-sensor", { crossing_id, up }),
  feed: (feed: "trains" | "traffic" | "incidents", up: boolean) =>
    post<{ notifications: AppNotification[] }>("/demo/feed", { feed, up }),
  clearLive: () => post<{ notifications: AppNotification[] }>("/demo/clear-live"),
  reset: () => post<ClockState>("/demo/reset"),
};
