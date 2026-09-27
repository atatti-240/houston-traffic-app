"use client";

/**
 * Driving mode's shared bits outside the app context (they change every second, and only the map's you-are-here
 * layer and the driving screen care):
 *  - where you are (the latest fix) and whether the map follows you,
 *  - the route handed from Trip's Start button to the driving screen.
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

let handed: { key: string; route: Route } | null = null;

/** Trip's Start: the picked route, for the driving screen that's about to open. */
export function handOff(trip: DriveTrip, route: Route) {
  handed = { key: tripKey(trip), route };
}

/** The route Start handed over for this trip (still there for Forward after End), or null after a reload. */
export function handedRoute(trip: DriveTrip): Route | null {
  return handed && handed.key === tripKey(trip) ? handed.route : null;
}
