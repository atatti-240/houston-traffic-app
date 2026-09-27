"use client";

/**
 * Search as you type, gently: waits until you pause (350 ms), needs 3 letters, keeps one request
 * in flight (the latest query goes next, the ones typed in between are skipped) and remembers
 * answers. The backend adds the geocoder's 1-request-per-second limit and its own cache.
 */

import { useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import type { GeoResult } from "@/lib/types";

export const MIN_CHARS = 3;
const DEBOUNCE_MS = 350;
const TIMEOUT_MS = 15000;

export type GeoState =
  | { status: "idle" }
  | { status: "loading"; results: GeoResult[] }
  | { status: "ok"; results: GeoResult[]; stale: boolean }
  | { status: "error"; message: string };

const answers = new Map<string, { results: GeoResult[]; stale: boolean }>();

function keyOf(q: string, near: { lat: number; lng: number } | null): string {
  return `${q.toLowerCase()}|${near ? `${near.lat.toFixed(2)},${near.lng.toFixed(2)}` : ""}`;
}

function message(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/abort/i.test(msg)) return "Search is taking too long. Try again in a moment.";
  if (/failed to fetch|networkerror|load failed/i.test(msg)) return "Can't reach BlindSpot right now.";
  if (/search is (down|busy)/i.test(msg)) return msg;
  return "Search isn't working right now.";
}

export function useGeocode(query: string, near: { lat: number; lng: number } | null): GeoState {
  const q = query.trim().replace(/\s+/g, " ");
  const [debounced, setDebounced] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  const [state, setState] = useState<{ key: string; value: GeoState }>({ key: "", value: { status: "idle" } });
  const wanted = useRef("");
  const busy = useRef(false);
  const nearRef = useRef(near);
  nearRef.current = near;
  const nearKey = near ? `${near.lat.toFixed(2)},${near.lng.toFixed(2)}` : "";

  useEffect(() => {
    const run = (text: string) => {
      const key = keyOf(text, nearRef.current);
      const known = answers.get(key);
      if (known) return setState({ key, value: { status: "ok", ...known } });
      busy.current = true;
      setState((s) => ({ key, value: { status: "loading", results: s.value.status === "ok" || s.value.status === "loading" ? s.value.results : [] } }));
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      api
        .geocode(text, nearRef.current, ctl.signal)
        .then(
          (r) => {
            const a = { results: r.results, stale: r.stale };
            answers.set(key, a);
            if (wanted.current === text) setState({ key, value: { status: "ok", ...a } });
          },
          (e: unknown) => {
            if (wanted.current === text) setState({ key, value: { status: "error", message: message(e) } });
          },
        )
        .finally(() => {
          clearTimeout(timer);
          busy.current = false;
          // Typed on meanwhile: ask for the latest query now.
          if (wanted.current !== text && wanted.current.length >= MIN_CHARS) run(wanted.current);
        });
    };
    wanted.current = debounced;
    if (debounced.length < MIN_CHARS) return setState({ key: "", value: { status: "idle" } });
    if (!busy.current) run(debounced);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, nearKey]);

  if (q.length < MIN_CHARS) return { status: "idle" };
  // Still typing (debouncing): keep what's on screen, marked as loading.
  if (state.key !== keyOf(q, near)) {
    const v = state.value;
    return { status: "loading", results: v.status === "ok" || v.status === "loading" ? v.results : [] };
  }
  return state.value;
}
