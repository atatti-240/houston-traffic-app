/** Helpers shared by the Where to and Trip screens. */

import type { Level } from "@/lib/theme";
import type { Location, Place, Route } from "@/lib/types";

/** Traffic level of a trip: how much longer it takes than on empty roads. */
export function tripLevel(r: Pick<Route, "total_min" | "breakdown">): Level {
  const free = r.breakdown.free_flow_min;
  if (!free) return "light";
  const ratio = r.total_min / free;
  return ratio <= 1.25 ? "light" : ratio <= 1.6 ? "moderate" : "heavy";
}

const ids = new WeakMap<object, number>();
let next = 1;

/** A number that changes every time live data is refetched (the slowdowns object is replaced
 * on each poll / refresh(), even when the frozen demo clock keeps `generated_at` the same). */
export function dataGeneration(data: object | null | undefined): number {
  if (!data) return 0;
  let id = ids.get(data);
  if (id === undefined) {
    id = next++;
    ids.set(data, id);
  }
  return id;
}

export function placeName(places: Place[], loc: Location | undefined): string {
  if (loc === undefined) return "";
  if (typeof loc === "string") return places.find((p) => p.id === loc)?.name ?? loc;
  return "Dropped pin";
}

export function placePoint(places: Place[], loc: Location): { lat: number; lng: number } | null {
  if (typeof loc !== "string") return loc;
  const p = places.find((x) => x.id === loc);
  return p ? { lat: p.lat, lng: p.lng } : null;
}
