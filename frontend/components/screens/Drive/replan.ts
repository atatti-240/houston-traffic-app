/**
 * Planning the drive from where you are: POST /route?directions=true with the current spot as the origin, and the
 * way you're heading (so the directions don't start with a U-turn). Only a route with turn-by-turn counts: without it
 * (the directions service down or busy) the old route keeps guiding.
 */

import { API_URL } from "@/lib/api";
import type { RouteChoices } from "@/lib/directions";
import type { Location, Route } from "@/lib/types";

/** The server gives the directions service about 8 s; routing comes on top. */
const TIMEOUT_MS = 15_000;

export class ReplanError extends Error {
  /** Worth trying again after about this long (the server said so), else null */
  readonly retryAfterS: number | null;
  /** A route came, without turn-by-turn */
  readonly noSteps: boolean;
  constructor(message: string, retryAfterS: number | null = null, noSteps = false) {
    super(message);
    this.retryAfterS = retryAfterS;
    this.noSteps = noSteps;
  }
}

export const hasSteps = (r: Route) => (r.directions?.status === "ok" || r.directions?.status === "partial") && r.directions.steps.length > 1;

/** The best route from `origin`. `needSteps`: fail when it has no turn-by-turn (a reroute keeps the old route then). */
export async function replan(
  body: {
    origin: Location;
    heading?: number;
    destination: Location;
    safety_weight: number;
    safe_path: boolean;
    avoid_tolls?: boolean;
    avoid_highways?: boolean;
  },
  { needSteps = true, signal: outer }: { needSteps?: boolean; signal?: AbortSignal } = {},
): Promise<Route> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const stop = () => ctl.abort();
  outer?.addEventListener("abort", stop);
  let res: Response;
  try {
    res = await fetch(`${API_URL}/route?directions=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: ctl.signal,
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { detail?: unknown; retry_after_s?: unknown };
      const retry = Number(err.retry_after_s);
      throw new ReplanError(typeof err.detail === "string" ? err.detail : res.statusText, Number.isFinite(retry) ? retry : null);
    }
    const data = (await res.json()) as RouteChoices;
    const best = data.best;
    if (!best?.geometry?.length) throw new ReplanError("No route");
    if (needSteps && !hasSteps(best)) throw new ReplanError(best.directions?.note ?? "No turn-by-turn directions", best.directions?.retry_after_s ?? null, true);
    return best;
  } catch (e) {
    if (e instanceof ReplanError) throw e;
    throw new ReplanError(ctl.signal.aborted ? "Timed out" : "Can't reach BlindSpot");
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", stop);
  }
}
