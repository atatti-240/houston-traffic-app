"use client";

/**
 * The Trip screen's route choices: which one is picked, and door-to-door directions for the ones that came back
 * "pending" (fetched one at a time, the picked route first: the public router takes about one request a second).
 *
 * The pick lives in this screen's browser history entry (and its URL, ?route=<id>), so Back, Forward and a reload
 * keep it; a new trip starts on the best route.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { routeDirections, type DirectionsPatch } from "@/lib/directions";
import type { Location, Route } from "@/lib/types";

const HISTORY_FIELD = "bsRoute";
const FAILED_NOTE = "Turn-by-turn directions aren't available right now. The line follows our main roads.";
const RETRY_MS = 60_000;

function initialPick(): string | null {
  if (typeof window === "undefined") return null;
  const saved = (window.history.state as Record<string, unknown> | null)?.[HISTORY_FIELD];
  return typeof saved === "string" ? saved : new URLSearchParams(window.location.search).get("route");
}

function rememberPick(id: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("route", id);
  // Keep the entry's other state (the app's screen stack, Next's router).
  window.history.replaceState({ ...(window.history.state ?? {}), [HISTORY_FIELD]: id }, "", `${url.pathname}${url.search}`);
}

export interface RouteChoiceState {
  /** The routes, with the directions fetched so far */
  routes: Route[];
  selected: Route | undefined;
  pick: (id: string) => void;
  /** Its times will still change (a trip to or from a point whose directions are on the way) */
  pendingTimes: (r: Route) => boolean;
  /** Its times don't include the way to and from our main roads, so they can't be compared with door-to-door ones
   * (a trip to or from a point whose directions are on the way or unavailable) */
  roughTimes: (r: Route) => boolean;
}

export function useRouteChoices(routes: Route[], origin: Location | undefined, to: Location | undefined): RouteChoiceState {
  const [picked, setPicked] = useState<string | null>(initialPick);
  // By trip, route and departure: the same roads leaving at another time have other times.
  const [patches, setPatches] = useState<Record<string, DirectionsPatch>>({});
  const [failed, setFailed] = useState<Record<string, number>>({});
  const busy = useRef(false);
  const trip = JSON.stringify([origin, to]);
  const timed = (origin !== undefined && typeof origin !== "string") || (to !== undefined && typeof to !== "string");
  const keyOf = useCallback((r: Route) => `${trip}|${r.id}|${r.depart_at}`, [trip]);

  const merged = useMemo(
    () =>
      routes.map((r): Route => {
        if (!r.id || r.directions?.status !== "pending") return r;
        const p = patches[keyOf(r)];
        if (p) return { ...r, ...p, breakdown: { ...r.breakdown, ...p.breakdown } };
        if (failed[keyOf(r)]) return { ...r, directions: { ...r.directions, status: "unavailable", note: FAILED_NOTE } };
        return r;
      }),
    [routes, patches, failed, keyOf],
  );
  const selected = merged.find((r) => r.id === picked) ?? merged[0];

  useEffect(() => {
    if (busy.current || origin === undefined || to === undefined) return;
    // Still pending, and not given up on in the last minute (asked again on a later refresh)
    const waiting = routes.filter((r) => r.id && r.directions?.status === "pending" && !patches[keyOf(r)] && !(Date.now() - (failed[keyOf(r)] ?? 0) < RETRY_MS));
    const next = waiting.find((r) => r.id === selected?.id) ?? waiting[0];
    if (!next) return;
    const key = keyOf(next);
    busy.current = true;
    routeDirections({ origin, destination: to, segment_ids: next.segments.map((s) => s.id), depart_at: next.depart_at })
      .then(
        (p) => setPatches((m) => ({ ...m, [key]: p })),
        () => setFailed((m) => ({ ...m, [key]: Date.now() })),
      )
      .finally(() => {
        busy.current = false;
      });
    // origin / to are in `trip` (keyOf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routes, patches, failed, selected?.id, keyOf]);

  const pick = useCallback((id: string) => {
    setPicked(id);
    rememberPick(id);
  }, []);
  const pendingTimes = useCallback((r: Route) => timed && r.directions?.status === "pending", [timed]);
  const roughTimes = useCallback(
    (r: Route) => timed && (r.directions?.status === "pending" || r.directions?.status === "unavailable"),
    [timed],
  );

  return { routes: merged, selected, pick, pendingTimes, roughTimes };
}
