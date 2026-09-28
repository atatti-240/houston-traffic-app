"use client";

/**
 * Driving mode's shared bits outside the app context (they change every second, and only the map's you-are-here
 * layer and the driving screen care):
 *  - where you are (the latest fix) and whether the map follows you,
 *  - the route handed from Trip's Start button to the driving screen (kept for the tab's session, so a reload goes on
 *    with the route you picked, not whichever is fastest now).
 */

import { useSyncExternalStore } from "react";

import type { Location, Route } from "@/lib/types";

export interface Fix {
  lat: number;
  lng: number;
  /** Meters (radius) */
  accuracy: number;
  /** Compass heading of travel, when known */
  heading: number | null;
  /** m/s, when known */
  speed: number | null;
  /** The demo's simulated drive: the speed it stands for (its `speed` is sped up), so turns are called at the
   * distances a real drive would get */
  realSpeed?: number;
  /** When it was taken (ms) */
  at: number;
  /** Real GPS, the demo's simulated drive, or the trip's start (no location) */
  source: "gps" | "sim" | "start";
}

interface State {
  /** Driving: the live dot replaces the map's static you-are-here dot */
  active: boolean;
  fix: Fix | null;
  follow: boolean;
  /** Bumped by Recenter (so the map zooms back in even when already following) */
  recenter: number;
}

let state: State = { active: false, fix: null, follow: true, recenter: 0 };
const listeners = new Set<() => void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export const drive = {
  start: () => set({ active: true, fix: null, follow: true }),
  stop: () => set({ active: false, fix: null, follow: true }),
  setFix: (fix: Fix) => set({ fix }),
  setFollow: (follow: boolean) => {
    if (state.follow !== follow) set({ follow });
  },
  recenter: () => set({ follow: true, recenter: state.recenter + 1 }),
  get: () => state,
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** A piece of the driving state; re-renders only when it changes. */
export function useDrive<T>(pick: (s: State) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => pick(state),
    () => pick({ active: false, fix: null, follow: true, recenter: 0 }),
  );
}

// ---- Start -> driving screen ---------------------------------------------------------------------

/** What the driving screen is for: the trip (so it can re-plan from where you are). */
export interface DriveTrip {
  to: Location;
  toName?: string;
  from?: Location;
  fromName?: string;
  safety?: number;
}

export const tripKey = (t: DriveTrip) => JSON.stringify([t.to, t.from ?? null, t.safety ?? 0]);

type Handed = { key: string; route: Route };
let handed: Handed | null = null;
const HANDED_KEY = "blindspot.drive";

/** Trip's Start (and each new route while driving): the route to drive, for the driving screen. */
export function handOff(trip: DriveTrip, route: Route) {
  handed = { key: tripKey(trip), route };
  try {
    sessionStorage.setItem(HANDED_KEY, JSON.stringify(handed));
  } catch {}
}

/** The route handed over for this trip (still there for Forward after End, and after a reload), or null. */
export function handedRoute(trip: DriveTrip): Route | null {
  if (!handed) {
    try {
      const raw = sessionStorage.getItem(HANDED_KEY);
      const saved = raw ? (JSON.parse(raw) as Handed | null) : null;
      if (saved && typeof saved.key === "string" && Array.isArray(saved.route?.geometry)) handed = saved;
    } catch {}
  }
  return handed && handed.key === tripKey(trip) ? handed.route : null;
}
