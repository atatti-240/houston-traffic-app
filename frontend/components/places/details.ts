"use client";

/** A place's details (hours, phone, website) from GET /geocode/details, cached per place. */

import { useEffect, useState } from "react";

import { useApp } from "@/components/app/AppContext";
import { api } from "@/lib/api";
import type { PlaceDetails, PlaceRef } from "@/lib/types";

export type DetailsState =
  | { status: "none" } // nothing to look up, or OpenStreetMap has nothing on it
  | { status: "loading" }
  | { status: "ok"; details: PlaceDetails }
  | { status: "error"; message: string };

const cache = new Map<string, Promise<PlaceDetails | null>>();

/** What to ask for, or null when there's nothing to look up (our own named places, dropped pins,
 * a spot saved as "where I am now"). */
function lookup(p: PlaceRef | null): { osm?: string; name?: string; lat?: number; lng?: number } | null {
  if (!p || p.placeId) return null;
  if (p.osm) return { osm: p.osm };
  const name = p.name.trim();
  if (!name || /^(dropped pin|my location|place|parking|gas station|ev charger)$/i.test(name)) return null;
  return { name, lat: p.lat, lng: p.lng };
}

/** `at`: work the hours out for this time (e.g. when you'd arrive) instead of the app's now. */
export function usePlaceDetails(place: PlaceRef | null, at?: string | null): DetailsState {
  const { clock } = useApp();
  const ref = lookup(place);
  // "Open now" follows the app's clock (the demo jumps it): ask again every 10 simulated minutes.
  const when = at ?? clock?.now.slice(0, 15) ?? "";
  const base = ref ? JSON.stringify(ref) : "";
  const key = `${base}\n${when}`;
  const [state, setState] = useState<{ key: string; value: DetailsState }>({ key: "", value: { status: "none" } });

  useEffect(() => {
    if (!ref) return;
    let live = true;
    let p = cache.get(key);
    if (!p) {
      p = api.placeDetails({ ...ref, at: at ?? undefined }).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        if (/no details/i.test(msg)) return null;
        cache.delete(key); // not found stays cached; errors are asked again
        throw e;
      });
      cache.set(key, p);
    }
    p.then(
      (d) => live && setState({ key, value: d ? { status: "ok", details: d } : { status: "none" } }),
      (e: unknown) => {
        if (!live) return;
        const msg = e instanceof Error ? e.message : String(e);
        setState({
          key,
          value: {
            status: "error",
            message: /failed to fetch|networkerror|load failed/i.test(msg) ? "Can't reach BlindSpot right now." : "Details aren't available right now.",
          },
        });
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!ref) return { status: "none" };
  // Keep showing the last answer for this place while the next one loads.
  if (state.key !== key) return state.value.status === "ok" && state.key.startsWith(`${base}\n`) ? state.value : { status: "loading" };
  return state.value;
}
