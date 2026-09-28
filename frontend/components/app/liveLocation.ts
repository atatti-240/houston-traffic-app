"use client";

/**
 * The device's live position, kept outside React so a GPS fix doesn't re-render the app.
 *
 * A small store with a subscribe / snapshot API (for `useSyncExternalStore`): only the map's
 * you-are-here dot and its follow logic read every fix. The app's "here" gets a throttled feed
 * (`watchHere`: significant moves only), and an open trip keeps the start it opened with (`useStableStart`).
 *
 * Permission: no surprise prompt. Already granted: watch from the start. Not decided yet: the same
 * one-time ask as before, then watch once it's allowed. Denied or no GPS: nothing happens (the app
 * falls back to its default place). Watching pauses while the tab is hidden.
 */

import { useState, useSyncExternalStore } from "react";

import type { Location } from "@/lib/types";

export interface Fix {
  lat: number;
  lng: number;
  /** meters (95%-ish radius the browser reports) */
  accuracy: number;
  /** degrees clockwise from north, or null when unknown (standing still, or no two good fixes yet) */
  heading: number | null;
  /** m/s, or null */
  speed: number | null;
  /** when the fix arrived (ms) */
  at: number;
}

export type LocStatus = "idle" | "asking" | "watching" | "paused" | "denied" | "unavailable";

export const HOUSTON_BOX = {
  minLat: 29.4,
  maxLat: 30.2,
  minLng: -95.9,
  maxLng: -94.9,
};

export function inHouston(p: { lat: number; lng: number }): boolean {
  const b = HOUSTON_BOX;
  return p.lat >= b.minLat && p.lat <= b.maxLat && p.lng >= b.minLng && p.lng <= b.maxLng;
}

export function metersApart(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bearing(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = Math.PI / 180;
  const y = Math.sin((b.lng - a.lng) * toRad) * Math.cos(b.lat * toRad);
  const x =
    Math.cos(a.lat * toRad) * Math.sin(b.lat * toRad) -
    Math.sin(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.cos((b.lng - a.lng) * toRad);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// ---- the store -----------------------------------------------------------------------------------

/** Fixes worse than this don't set the heading (a jump inside the error circle isn't a direction). */
const HEADING_MAX_ACCURACY_M = 50;
/** Move at least this far from the last heading point before taking a bearing from the fixes. */
const HEADING_MIN_MOVE_M = 12;

let fix: Fix | null = null;
let status: LocStatus = "idle";
const listeners = new Set<() => void>();

let users = 0;
let watchId: number | null = null;
/** Allowed to watch (granted); false until then, and after a denial. */
let allowed = false;
/** The one-time ask on load happens once per page, not once per mount. */
let asked = false;
let headingFrom: { lat: number; lng: number } | null = null;
let permission: PermissionStatus | null = null;

function emit() {
  for (const l of listeners) l();
}

function setStatus(s: LocStatus) {
  if (s === status) return;
  status = s;
  emit();
}

function onPosition(pos: GeolocationPosition) {
  const c = pos.coords;
  const next = { lat: c.latitude, lng: c.longitude };
  const good = c.accuracy <= HEADING_MAX_ACCURACY_M;
  let heading = fix?.heading ?? null;
  if (good && c.heading !== null && Number.isFinite(c.heading) && (c.speed ?? 0) > 0.5) {
    heading = c.heading;
    headingFrom = next;
  } else if (good) {
    if (!headingFrom) headingFrom = next;
    else if (metersApart(headingFrom, next) >= HEADING_MIN_MOVE_M) {
      heading = bearing(headingFrom, next);
      headingFrom = next;
    }
  }
  fix = {
    ...next,
    accuracy: c.accuracy,
    heading,
    speed: c.speed ?? null,
    at: Date.now(),
  };
  emit();
}

function onError(err: GeolocationPositionError) {
  if (err.code === err.PERMISSION_DENIED) {
    allowed = false;
    stopWatch();
    setStatus("denied");
  }
  // Timeout / no fix yet: keep watching, a fix may still come.
}

function startWatch() {
  if (watchId !== null || !allowed || users === 0) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return setStatus("paused");
  watchId = navigator.geolocation.watchPosition(onPosition, onError, {
    enableHighAccuracy: true,
    maximumAge: 3000,
  });
  setStatus("watching");
}

function stopWatch() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

function allow() {
  allowed = true;
  startWatch();
}

/** Today's one-time ask on load: a prompt only when the browser hasn't decided yet. */
function askOnce() {
  if (asked) return;
  asked = true;
  setStatus("asking");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      onPosition(pos);
      allow();
    },
    (err) => {
      // A timeout means it was allowed but slow: watch for the fix.
      if (err.code === err.PERMISSION_DENIED) onError(err);
      else allow();
    },
    { timeout: 5000, maximumAge: 600000 },
  );
}

function onPermission(state: PermissionState) {
  if (state === "granted") allow();
  else if (state === "denied") {
    allowed = false;
    stopWatch();
    setStatus("denied");
  } else askOnce();
}

function onVisibility() {
  if (document.visibilityState === "hidden") {
    if (watchId !== null) {
      stopWatch();
      setStatus("paused");
    }
  } else startWatch();
}

/** Start following the device (ref-counted; the returned function stops it). Safe to call anywhere. */
export function startLiveLocation(): () => void {
  if (typeof navigator === "undefined") return () => {};
  users += 1;
  if (users === 1) {
    if (!navigator.geolocation) setStatus("unavailable");
    else {
      document.addEventListener("visibilitychange", onVisibility);
      if (allowed) startWatch();
      else if (navigator.permissions?.query) {
        navigator.permissions
          .query({ name: "geolocation" })
          .then((p) => {
            if (users === 0) return;
            permission = p;
            p.onchange = () => onPermission(p.state);
            onPermission(p.state);
          })
          .catch(askOnce);
      } else askOnce();
    }
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    users -= 1;
    if (users > 0) return;
    stopWatch();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    if (permission) permission.onchange = null;
    permission = null;
    if (status === "watching" || status === "paused") setStatus("idle");
  };
}

export function subscribeLiveLocation(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export const getLiveFix = (): Fix | null => fix;
export const getLiveStatus = (): LocStatus => status;
const serverNull = () => null;
const serverIdle = (): LocStatus => "idle";

/** The latest fix (re-renders on every fix: only for the dot and follow logic). */
export function useLiveFix(): Fix | null {
  return useSyncExternalStore(subscribeLiveLocation, getLiveFix, serverNull);
}

export function useLiveStatus(): LocStatus {
  return useSyncExternalStore(subscribeLiveLocation, getLiveStatus, serverIdle);
}

// ---- "here" for the app: significant moves only ---------------------------------------------------

/** The app's "here" moves only when you've gone this far... */
export const HERE_MIN_MOVE_M = 150;
/** ...and at most this often (ms), so trip ETAs and nearby lists don't refetch on every fix. */
export const HERE_MIN_INTERVAL_MS = 15000;
/** A fix this vague doesn't move "here" once there is one. */
const HERE_MAX_ACCURACY_M = 500;

/**
 * Start live location and call `set` with the device's spot in Houston (or null outside it): the first
 * fix right away, then only on a significant move. Returns the cleanup.
 */
export function watchHere(set: (p: { lat: number; lng: number } | null) => void): () => void {
  let last: { lat: number; lng: number } | null = null;
  let lastAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const apply = () => {
    timer = null;
    const f = fix;
    if (!f) return;
    const p = inHouston(f) ? { lat: f.lat, lng: f.lng } : null;
    last = p;
    lastAt = Date.now();
    set(p);
  };

  const check = () => {
    const f = fix;
    if (!f) return;
    const inside = inHouston(f);
    if (!last) {
      if (inside) apply(); // first fix in Houston: use it now
      return;
    }
    if (!inside) {
      if (!timer) timer = setTimeout(apply, Math.max(0, lastAt + HERE_MIN_INTERVAL_MS - Date.now()));
      return;
    }
    if (f.accuracy > HERE_MAX_ACCURACY_M || metersApart(last, f) < HERE_MIN_MOVE_M) return;
    const wait = lastAt + HERE_MIN_INTERVAL_MS - Date.now();
    if (wait <= 0) apply();
    else if (!timer) timer = setTimeout(apply, wait); // the latest fix when the wait is up
  };

  const unsub = subscribeLiveLocation(check);
  const stop = startLiveLocation();
  check();
  return () => {
    unsub();
    stop();
    if (timer) clearTimeout(timer);
  };
}

// ---- following on the map -----------------------------------------------------------------------

let follow = { on: false, seq: 0 };
const followListeners = new Set<() => void>();

function emitFollow() {
  for (const l of followListeners) l();
}

/** Ask for location now (a tap is a fine moment to ask), unless it's already allowed, denied or being asked. */
export function askForLocation() {
  if (typeof navigator !== "undefined" && navigator.geolocation && !allowed && status !== "denied" && status !== "asking") {
    asked = false;
    askOnce();
  }
}

/** The locate button: center on you and keep following (again: recenter). Asks for location if it never did. */
export function locateMe() {
  follow = { on: true, seq: follow.seq + 1 };
  askForLocation();
  emitFollow();
}

export function stopFollowing() {
  if (!follow.on) return;
  follow = { ...follow, on: false };
  emitFollow();
}

function subscribeFollow(cb: () => void): () => void {
  followListeners.add(cb);
  return () => {
    followListeners.delete(cb);
  };
}

const getFollow = () => follow;
const serverFollow = { on: false, seq: 0 };

export function useFollow(): { on: boolean; seq: number } {
  return useSyncExternalStore(subscribeFollow, getFollow, () => serverFollow);
}

// ---- a trip's start ----------------------------------------------------------------------------

interface StartLike {
  lat: number;
  lng: number;
  fromDevice: boolean;
  start: Location;
  startName: string;
}

/** Past this, an open trip takes your new spot as its start (and re-plans). */
const TRIP_RESTART_M = 1000;

/**
 * Where an open trip starts from: `here` as it was when the trip (`key`) opened, kept while you move a
 * little so the trip doesn't re-plan on every update. It still switches from the default place to the
 * device once a fix comes in, and follows a big move.
 */
export function useStableStart<T extends StartLike>(here: T | null, key: string): T | null {
  const [kept, setKept] = useState<{ key: string; here: T } | null>(here ? { key, here } : null);
  let use = kept && kept.key === key ? kept.here : null;
  const refresh =
    here &&
    (!use || (here.fromDevice && !use.fromDevice) || (here.fromDevice && use.fromDevice && metersApart(use, here) > TRIP_RESTART_M));
  if (refresh) use = here;
  if (use !== (kept?.key === key ? kept.here : null)) setKept(use ? { key, here: use } : null);
  return use;
}
