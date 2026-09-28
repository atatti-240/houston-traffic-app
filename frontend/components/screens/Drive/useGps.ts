"use client";

/**
 * Live GPS for driving mode, from the app's one live location (components/app/liveLocation.ts), so there's a single
 * watchPosition for the whole app. It doesn't set off the browser's permission prompt by itself: when the site
 * hasn't been allowed yet it waits in "ask" until `allow()` (our own friendly ask comes first). Heading and speed
 * come from the fix, or from the last two fixes when the device doesn't say.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  askForLocation,
  getLiveFix,
  getLiveStatus,
  startLiveLocation,
  subscribeLiveLocation,
  type Fix as LiveFix,
} from "@/components/app/liveLocation";
import type { Fix } from "@/components/drive/store";
import { bearing, distanceM } from "@/lib/drive/geo";

/**
 * checking: asking the browser what's allowed · ask: waiting for our "Use my location" · waiting: allowed, no fix yet
 * live: fixes coming · denied: the browser said no · off: "Not now" · unavailable: this browser has no location
 */
export type GpsState = "checking" | "ask" | "waiting" | "live" | "denied" | "off" | "unavailable";

const MOVED_M = 8; // moved at least this much (and more than the fix's error): the heading from the last fix means something

export function useGps(onFix: (f: Fix) => void): { state: GpsState; allow: () => void; decline: () => void } {
  const [state, setState] = useState<GpsState>("checking");
  /** Stops listening to the live location (null: not started) */
  const watch = useRef<(() => void) | null>(null);
  const last = useRef<Fix | null>(null);
  const onFixRef = useRef(onFix);
  onFixRef.current = onFix;

  const start = useCallback(() => {
    if (watch.current !== null || typeof navigator === "undefined" || !navigator.geolocation) return;
    setState((s) => (s === "live" ? s : "waiting"));
    let seen: LiveFix | null = null;
    const check = () => {
      if (getLiveStatus() === "denied") {
        watch.current?.();
        watch.current = null;
        setState("denied");
        return;
      }
      const live = getLiveFix();
      if (!live || live === seen) return;
      seen = live;
      const { lat, lng, accuracy, at } = live;
      const prev = last.current;
      const moved = prev ? distanceM([prev.lat, prev.lng], [lat, lng]) : 0;
      const dt = prev ? (at - prev.at) / 1000 : 0;
      let heading = live.heading;
      if (heading === null) heading = prev && moved >= Math.max(MOVED_M, accuracy / 2) ? bearing([prev.lat, prev.lng], [lat, lng]) : (prev?.heading ?? null);
      const speed = live.speed !== null && Number.isFinite(live.speed) ? live.speed : prev && dt > 0 && dt < 30 ? moved / dt : null;
      const fix: Fix = { lat, lng, accuracy: Number.isFinite(accuracy) ? accuracy : 50, heading, speed, at, source: "gps" };
      last.current = fix;
      setState("live");
      onFixRef.current(fix);
    };
    const unsub = subscribeLiveLocation(check);
    const stop = startLiveLocation();
    watch.current = () => {
      unsub();
      stop();
    };
    askForLocation(); // our "Use my location" (or already allowed: nothing to ask)
    check();
  }, []);

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setState("unavailable");
      return;
    }
    let alive = true;
    let status: PermissionStatus | null = null;
    const apply = (s: PermissionState) => {
      if (!alive) return;
      if (s === "granted") start();
      else if (s === "denied") setState("denied");
      else setState((cur) => (cur === "checking" ? "ask" : cur));
    };
    const onChange = () => status && apply(status.state);
    if (navigator.permissions?.query) {
      navigator.permissions
        .query({ name: "geolocation" as PermissionName })
        .then((st) => {
          if (!alive) return; // gone before the browser answered: nothing to listen for
          status = st;
          st.addEventListener("change", onChange);
          apply(st.state);
        })
        .catch(() => apply("prompt"));
    } else apply("prompt");
    return () => {
      alive = false;
      status?.removeEventListener("change", onChange);
      watch.current?.();
      watch.current = null;
    };
  }, [start]);

  const decline = useCallback(() => setState("off"), []);
  return { state, allow: start, decline };
}
