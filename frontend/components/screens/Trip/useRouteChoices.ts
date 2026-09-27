"use client";

/**
 * The Trip screen's route choices: which one is picked, and door-to-door directions for the ones that came back
 * "pending" (fetched one at a time, the picked route first: the public router takes about one request a second).
 *
 * Directions that failed only for now (the router down or busy, too many asks: "unavailable" with a retry_after_s, or
 * no answer) are asked for again a few times, further apart each time and never sooner than the server says; the
 * route's line, times and steps change in place when they come. One that would fail again isn't asked again.
 *
 * The pick lives in this screen's browser history entry (and its URL, ?route=<id>), so Back, Forward and a reload
 * keep it; a new trip starts on the best route.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DirectionsError, routeDirections, type DirectionsPatch } from "@/lib/directions";
import type { Location, Route, RouteDirections } from "@/lib/types";

const HISTORY_FIELD = "bsRoute";
const FAILED_NOTE = "Turn-by-turn directions aren't available right now. The line follows our main roads.";
const ROUGH_NOTE = "Times cover the main roads only."; // as the server says it, to or from a point
const RETRY_NOTE = "Trying again shortly.";
// At most MAX_TRIES asks per route and departure, the n-th retry at least BACKOFF_S[n - 1] after the last ask (or
// later when the server says so), plus a little jitter so screens don't ask in step. After that only a refetch of
// the trip, SPENT_MS or more after the last ask, gets one more.
const MAX_TRIES = 4;
const BACKOFF_S = [5, 20, 60];
const SPENT_MS = 60_000;
const GAP_MS = 3000; // never the same route twice in this long (its answer may not be in the state yet)

/** Failed asks for a route's directions: how many, when the next may go (ms), and `never` when it can't help. */
type Tries = { n: number; at: number; never?: boolean };

/** Unavailable only for now: worth asking again */
const failedForNow = (d: RouteDirections | undefined) => d?.status === "unavailable" && d.retry_after_s != null;
/** Still to be asked for, or asked for again */
const wanted = (r: Route) => !!r.id && (r.directions?.status === "pending" || failedForNow(r.directions));

/** When to ask again after `n` failed asks, the last one at `now` (the server said `serverS`). */
function nextTry(n: number, serverS: number | null | undefined, now: number, jitter: number): number {
  if (n >= MAX_TRIES) return now + SPENT_MS;
  return now + Math.max(serverS ?? 0, BACKOFF_S[Math.min(n, BACKOFF_S.length) - 1]) * 1000 * jitter;
}

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
  const [tries, setTries] = useState<Record<string, Tries>>({});
  const [wake, setWake] = useState(0); // bumped when a retry is due
  const busy = useRef(false);
  const askedAt = useRef<Record<string, number>>({});
  // When these routes came: a first route that failed for now counts its wait from then, and a refetch gives a route
  // that's out of tries one more.
  const came = useRef<{ routes: Route[]; at: number }>({ routes: [], at: 0 });
  const trip = JSON.stringify([origin, to]);
  const timed = (origin !== undefined && typeof origin !== "string") || (to !== undefined && typeof to !== "string");
  const keyOf = useCallback((r: Route) => `${trip}|${r.id}|${r.depart_at}`, [trip]);
  const failedNote = timed ? `${FAILED_NOTE} ${ROUGH_NOTE}` : FAILED_NOTE;

  const merged = useMemo(
    () =>
      routes.map((r): Route => {
        if (!wanted(r)) return r;
        const key = keyOf(r);
        const p = patches[key];
        const withPatch = p ? { ...r, ...p, breakdown: { ...r.breakdown, ...p.breakdown } } : r;
        if (p && !failedForNow(p.directions)) return withPatch;
        const t = tries[key];
        const shown =
          !p && t && r.directions?.status === "pending"
            ? { ...r, directions: { ...r.directions, status: "unavailable" as const, note: failedNote } }
            : withPatch;
        // Say so while they'll be asked for again (a first route that failed for now: /route asked once)
        const d = shown.directions;
        if (d?.status !== "unavailable" || t?.never || (t?.n ?? 1) >= MAX_TRIES) return shown;
        return { ...shown, directions: { ...d, note: `${d.note ?? failedNote} ${RETRY_NOTE}` } };
      }),
    [routes, patches, tries, keyOf, failedNote],
  );
  const selected = merged.find((r) => r.id === picked) ?? merged[0];

  useEffect(() => {
    if (origin === undefined || to === undefined) return;
    const now = Date.now();
    if (came.current.routes !== routes) came.current = { routes, at: now };
    if (busy.current) return;
    // When each route's directions can be asked for (again); null: got them, or asking again won't help
    const due = (r: Route): number | null => {
      if (!wanted(r)) return null;
      const key = keyOf(r);
      const p = patches[key];
      if (p && !failedForNow(p.directions)) return null;
      const t = tries[key];
      let at: number | null;
      if (!t) at = failedForNow(r.directions) ? nextTry(1, r.directions?.retry_after_s, came.current.at, 1) : now;
      else if (t.never) at = null;
      else if (t.n >= MAX_TRIES) at = came.current.at >= t.at ? now : null;
      else at = t.at;
      return at === null ? null : Math.max(at, (askedAt.current[key] ?? 0) + GAP_MS);
    };
    const queue = routes.flatMap((r) => {
      const at = due(r);
      return at === null ? [] : [{ r, at }];
    });
    const ready = queue.filter((q) => q.at <= now).map((q) => q.r);
    const next = ready.find((r) => r.id === selected?.id) ?? ready[0];
    if (!next) {
      if (!queue.length) return;
      const timer = window.setTimeout(() => setWake((w) => w + 1), Math.min(...queue.map((q) => q.at)) - now + 50);
      return () => window.clearTimeout(timer);
    }
    const key = keyOf(next);
    const asked = failedForNow(next.directions) ? 1 : 0; // /route or /recommend asked once already
    const failed = (serverS: number | null) => {
      const at = Date.now();
      const jitter = 1 + Math.random() * 0.2;
      setTries((m) => {
        const n = (m[key]?.n ?? asked) + 1;
        return { ...m, [key]: serverS === null ? { n, at, never: true } : { n, at: nextTry(n, serverS, at, jitter) } };
      });
    };
    busy.current = true;
    askedAt.current[key] = now;
    routeDirections({ origin, destination: to, segment_ids: next.segments.map((s) => s.id), depart_at: next.depart_at }).then(
      (p) => {
        busy.current = false;
        if (failedForNow(p.directions)) failed(p.directions.retry_after_s ?? 0);
        setPatches((m) => ({ ...m, [key]: p }));
      },
      (e: unknown) => {
        busy.current = false;
        failed(e instanceof DirectionsError ? e.retryAfterS : 0);
      },
    );
    // origin / to are in `trip` (keyOf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routes, patches, tries, wake, selected?.id, keyOf]);

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
