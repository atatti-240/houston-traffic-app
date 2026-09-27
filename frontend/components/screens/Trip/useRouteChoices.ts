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
}

export function useRouteChoices(routes: Route[], origin: Location | undefined, to: Location | undefined): RouteChoiceState {
  const [picked, setPicked] = useState<string | null>(initialPick);
  const [patches, setPatches] = useState<Record<string, DirectionsPatch | "failed">>({});
  const busy = useRef(false);
  const trip = JSON.stringify([origin, to]);
  const timed = (origin !== undefined && typeof origin !== "string") || (to !== undefined && typeof to !== "string");

  const merged = useMemo(
    () =>
      routes.map((r): Route => {
        const p = r.id ? patches[`${trip}|${r.id}`] : undefined;
        if (!p || r.directions?.status !== "pending") return r;
        if (p === "failed") return { ...r, directions: { ...r.directions, status: "unavailable", note: FAILED_NOTE } };
        return { ...r, ...p, breakdown: { ...r.breakdown, ...p.breakdown } };
      }),
    [routes, patches, trip],
  );
  const selected = merged.find((r) => r.id === picked) ?? merged[0];

  useEffect(() => {
    if (busy.current || origin === undefined || to === undefined) return;
    const waiting = merged.filter((r) => r.id && r.directions?.status === "pending");
    const next = waiting.find((r) => r.id === selected?.id) ?? waiting[0];
    if (!next?.id) return;
    const key = `${trip}|${next.id}`;
    busy.current = true;
    routeDirections({ origin, destination: to, segment_ids: next.segments.map((s) => s.id), depart_at: next.depart_at })
      .then(
        (p) => setPatches((m) => ({ ...m, [key]: p })),
        () => setPatches((m) => ({ ...m, [key]: "failed" })),
      )
      .finally(() => {
        busy.current = false;
      });
    // origin / to are in `trip`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merged, selected?.id, trip]);

  const pick = useCallback((id: string) => {
    setPicked(id);
    rememberPick(id);
  }, []);
  const pendingTimes = useCallback((r: Route) => timed && r.directions?.status === "pending", [timed]);

  return { routes: merged, selected, pick, pendingTimes };
}
