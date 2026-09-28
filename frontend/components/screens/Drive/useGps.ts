"use client";

/**
 * Live GPS for driving mode (navigator.geolocation.watchPosition). It doesn't set off the browser's permission
 * prompt by itself: when the site hasn't been allowed yet it waits in "ask" until `allow()` (our own friendly ask
 * comes first). Heading and speed come from the fix, or from the last two fixes when the device doesn't say.
 */

import { useCallback, useEffect, useRef, useState } from "react";

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
  const watch = useRef<number | null>(null);
  const last = useRef<Fix | null>(null);
  const onFixRef = useRef(onFix);
  onFixRef.current = onFix;

  const start = useCallback(() => {
    if (watch.current !== null || typeof navigator === "undefined" || !navigator.geolocation) return;
    setState((s) => (s === "live" ? s : "waiting"));
    watch.current = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude: lat, longitude: lng, accuracy, heading: h, speed: v } = pos.coords;
        const prev = last.current;
        const at = Date.now();
        const moved = prev ? distanceM([prev.lat, prev.lng], [lat, lng]) : 0;
        const dt = prev ? (at - prev.at) / 1000 : 0;
        let heading: number | null = h !== null && Number.isFinite(h) && (v ?? 1) > 0.5 ? h : null;
        if (heading === null) heading = prev && moved >= Math.max(MOVED_M, accuracy / 2) ? bearing([prev.lat, prev.lng], [lat, lng]) : (prev?.heading ?? null);
        const speed = v !== null && Number.isFinite(v) ? v : prev && dt > 0 && dt < 30 ? moved / dt : null;
        const fix: Fix = { lat, lng, accuracy: Number.isFinite(accuracy) ? accuracy : 50, heading, speed, at, source: "gps" };
        last.current = fix;
        setState("live");
        onFixRef.current(fix);
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          if (watch.current !== null) navigator.geolocation.clearWatch(watch.current);
          watch.current = null;
          setState("denied");
        }
        // No signal or too slow: keep watching, it may come
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20_000 },
    );
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
      if (watch.current !== null) navigator.geolocation.clearWatch(watch.current);
      watch.current = null;
    };
  }, [start]);

  const decline = useCallback(() => setState("off"), []);
  return { state, allow: start, decline };
}
