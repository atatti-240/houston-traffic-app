/** Driver reports: the kinds (labels, icons, colors), the API, and one small store shared by the
 * map pins, the Report sheet and the screens that list reports. */

import { useSyncExternalStore } from "react";

import { call, post } from "./api";

export type ReportKind = "crash" | "police" | "hazard" | "pothole" | "stalled" | "flooding";

export interface DriverReport {
  id: number;
  kind: ReportKind;
  /** "Stalled car" */
  label: string;
  /** "Stalled car reported" */
  title: string;
  /** Pin position: on its direction's line when it's on one of our roads */
  lat: number;
  lng: number;
  segment_id: string | null;
  /** Flooding: the road's other direction, flooded too where the two run together */
  also_on?: string | null;
  /** "Westheimer Rd northbound" (null off our roads) */
  road: string | null;
  /** "I-69 / 610 West to Galleria / Uptown", or "Near Midtown" off our roads */
  place: string;
  note: string;
  created_at: string;
  expires_at: string;
  still_there: number;
  not_there: number;
  /** "Reported by drivers, 12 min ago, 3 still there" */
  provenance: string;
  source: string;
  /** The demo's canned reports */
  demo: boolean;
  /** Slows its road (routes may go around it) */
  affects_routing: boolean;
  /** Minutes it adds to its road right now */
  delay_min: number | null;
  /** Adds nothing right now: another incident on the same road slows it more */
  outweighed: boolean;
  /** How you stand on it */
  mine: "reported" | "still_there" | "not_there" | null;
}

export interface SnapSpot {
  segment_id: string | null;
  road: string | null;
  place: string | null;
  lat: number;
  lng: number;
}

export interface SnapResult extends SnapSpot {
  on_road: boolean;
  /** About as close to both directions */
  ambiguous: boolean;
  /** The other direction, when it runs here too */
  other: SnapSpot | null;
}

// ---- kinds -------------------------------------------------------------------------------------

/** 24x24 stroke icons in the design's style. */
export const REPORT_ICON = "M5 4h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-9l-5 4v-4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM12 7.5v4M12 14v.01";

const WAVE = (y: number) => `M3 ${y}c1.5 0 1.5-1 3-1s1.5 1 3 1 1.5-1 3-1 1.5 1 3 1 1.5-1 3-1 1.5 1 3 1`;

export const REPORT_KINDS: Record<ReportKind, { label: string; hint: string; icon: string; color: string; ink: string }> = {
  crash: {
    label: "Crash",
    hint: "Slows traffic",
    icon: "M12 3l1.8 4.2 4.4-1.4-1.4 4.4L21 12l-4.2 1.8 1.4 4.4-4.4-1.4L12 21l-1.8-4.2-4.4 1.4 1.4-4.4L3 12l4.2-1.8-1.4-4.4 4.4 1.4z",
    color: "#FF4D4D",
    ink: "#11141A",
  },
  police: {
    label: "Police",
    hint: "Heads-up",
    icon: "M7 17v-5a5 5 0 0 1 10 0v5M5 17h14v3H5zM12 3v2M5.6 5.6L7 7M18.4 5.6L17 7",
    color: "#5B7BFF",
    ink: "#FFFFFF",
  },
  hazard: {
    label: "Hazard",
    hint: "Object on road",
    icon: "M10.3 3.9L2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 16.5v.5",
    color: "#F5C518",
    ink: "#11141A",
  },
  pothole: {
    label: "Pothole",
    hint: "Heads-up",
    icon: "M3 16c0-2.2 4-4 9-4s9 1.8 9 4-4 4-9 4-9-1.8-9-4zM7 16.5c1.2-.9 3-1.4 5-1.4s3.8.5 5 1.4M9 7l1 3M15 7l-1 3M12 5v4",
    color: "#C49A6C",
    ink: "#11141A",
  },
  stalled: {
    label: "Stalled car",
    hint: "Slows traffic",
    icon: "M5 13l1.5-4.5A2 2 0 0 1 8.4 7h7.2a2 2 0 0 1 1.9 1.5L19 13M4 13h16v4H4zM7 17v2M17 17v2",
    color: "#FF8A3D",
    ink: "#11141A",
  },
  flooding: {
    label: "Flooding",
    hint: "Slows traffic",
    icon: [8, 13, 18].map(WAVE).join(""),
    color: "#3BA3E0",
    ink: "#11141A",
  },
};

export const REPORT_ORDER: ReportKind[] = ["crash", "police", "hazard", "pothole", "stalled", "flooding"];

export const NOTE_MAX = 140;

/** Houston area (reports outside it are refused). */
export const HOUSTON = { minLat: 29.4, maxLat: 30.2, minLng: -95.9, maxLng: -94.9 };

export function inHouston(p: { lat: number; lng: number }): boolean {
  return p.lat >= HOUSTON.minLat && p.lat <= HOUSTON.maxLat && p.lng >= HOUSTON.minLng && p.lng <= HOUSTON.maxLng;
}

// ---- API ---------------------------------------------------------------------------------------

export const reportsApi = {
  list: () => call<{ generated_at: string; items: DriverReport[] }>("/reports"),
  snap: (lat: number, lng: number) => call<SnapResult>(`/reports/snap?lat=${lat.toFixed(6)}&lng=${lng.toFixed(6)}`),
  create: (body: { kind: ReportKind; lat: number; lng: number; note?: string; segment_id?: string | null }) =>
    post<{ report: DriverReport; merged: boolean }>("/reports", body),
  vote: (id: number, still_there: boolean) =>
    post<{ removed: boolean; report: DriverReport | null }>(`/reports/${id}/vote`, { still_there }),
};

/** Backend / network errors in the app's words. */
export function reportError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/failed to fetch|networkerror|load failed/i.test(msg)) return "Can't reach BlindSpot right now. Try again in a moment.";
  if (msg.startsWith("[") || msg.startsWith("{")) return "Couldn't send that. Check it and try again.";
  return msg;
}

// ---- store -------------------------------------------------------------------------------------

/** The report being written in the sheet. */
export interface Draft {
  kind: ReportKind | null;
  /** Where I am (`here`), or a spot picked on the map */
  where: "here" | "spot";
  spot: { lat: number; lng: number } | null;
  /** The road direction chosen with "Switch direction" (null = the nearest one) */
  segmentId: string | null;
  note: string;
}

interface State {
  items: DriverReport[];
  loaded: boolean;
  /** The pin whose card is open */
  selected: number | null;
  /** The Report sheet is open */
  draft: Draft | null;
  /** Waiting for a tap on the map */
  picking: boolean;
  /** Where the report would go, drawn on the map while the sheet is open */
  preview: { lat: number; lng: number } | null;
  /** A short confirmation shown over the map */
  flash: string | null;
}

let state: State = { items: [], loaded: false, selected: null, draft: null, picking: false, preview: null, flash: null };
const listeners = new Set<() => void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

const snapshot = () => state;

export function useReports(): State {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function setReports(items: DriverReport[]) {
  set({ items, loaded: true, selected: items.some((r) => r.id === state.selected) ? state.selected : null });
}

/** Bumped by every local change (a report sent, a vote): a list fetched before one is out of date. */
let edits = 0;
export const reportsEdits = () => edits;

export function upsertReport(r: DriverReport) {
  edits++;
  const i = state.items.findIndex((x) => x.id === r.id);
  set({ items: i < 0 ? [r, ...state.items] : state.items.map((x) => (x.id === r.id ? r : x)) });
}

export function dropReport(id: number) {
  edits++;
  set({ items: state.items.filter((x) => x.id !== id), selected: state.selected === id ? null : state.selected });
}

export function selectReport(id: number | null) {
  if (state.selected !== id) set({ selected: id });
}

export function openReport(kind: ReportKind | null = null, where: Draft["where"] = "here") {
  set({ draft: { kind, where, spot: null, segmentId: null, note: "" }, picking: false, preview: null, selected: null });
}

export function closeReport() {
  set({ draft: null, picking: false, preview: null });
}

export function editDraft(patch: Partial<Draft>) {
  if (state.draft) set({ draft: { ...state.draft, ...patch } });
}

export function startPicking() {
  if (state.draft) set({ picking: true, selected: null });
}

export function cancelPicking() {
  const d = state.draft;
  set({ picking: false, draft: d && !d.spot ? { ...d, where: "here" } : d });
}

export function pickSpot(spot: { lat: number; lng: number }) {
  if (state.draft) set({ picking: false, draft: { ...state.draft, where: "spot", spot, segmentId: null } });
}

export function setPreview(p: { lat: number; lng: number } | null) {
  const cur = state.preview;
  if (cur === p || (cur && p && cur.lat === p.lat && cur.lng === p.lng)) return;
  set({ preview: p });
}

let flashTimer: ReturnType<typeof setTimeout> | undefined;
export function flash(text: string) {
  clearTimeout(flashTimer);
  set({ flash: text });
  flashTimer = setTimeout(() => set({ flash: null }), 3200);
}

/** The backend's answer when a report expired or was taken down since the list was fetched. */
const GONE = /no longer up/i;

/** Vote on a report and update the store. */
export async function voteReport(r: DriverReport, stillThere: boolean): Promise<void> {
  let res: Awaited<ReturnType<typeof reportsApi.vote>>;
  try {
    res = await reportsApi.vote(r.id, stillThere);
  } catch (e) {
    if (!(e instanceof Error && GONE.test(e.message))) throw e;
    dropReport(r.id);
    flash("That one's already off the map.");
    return;
  }
  if (res.removed || !res.report) {
    dropReport(r.id);
    flash(r.mine === "reported" ? "Your report is off the map." : "Thanks. It's off the map.");
  } else {
    upsertReport(res.report);
  }
}
