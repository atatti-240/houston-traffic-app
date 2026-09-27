"use client";

/**
 * Nearby: the closest gas stations, EV chargers or parking, around you or along your route
 * ("Gas near me" from the map's layers menu, "Gas on the way" from a trip). Straight from the
 * street map's OpenStreetMap data (see pois.ts): no prices or live availability, and it says so.
 * Phone: a sheet with the places on the map above it. Desktop: the left panel.
 */

import { useEffect, useMemo, useState } from "react";

import { useApp, type MapPoint } from "@/components/app/AppContext";
import { BackHeader, FilterChip, Icon } from "@/components/ui";
import { C } from "@/lib/theme";
import type { LatLngTuple } from "@/lib/types";

import { tripTo } from "./nav";
import PlaceCard from "./PlaceCard";
import { POI, POI_KINDS, findAlong, findNear, miles, type NearbyItem } from "./pois";
import { setNearbyMarkers, useNearbyMarkers, type PoiKind } from "./store";

type State = { key: string; status: "loading" } | { key: string; status: "ok"; items: NearbyItem[] } | { key: string; status: "error" };

const NOUN: Record<PoiKind, [string, string]> = {
  fuel: ["gas station", "gas stations"],
  ev: ["EV charger", "EV chargers"],
  parking: ["parking lot", "parking lots"],
};

function refOf(it: NearbyItem) {
  return { name: it.name, lat: it.lat, lng: it.lng, osm: it.osm, kind: it.sub, color: POI[it.kind].color };
}

export default function Nearby() {
  const { screen, here, back, go, setScene, isDesktop, focus } = useApp();
  const params = screen.name === "nearby" ? screen : null;
  const route = params?.route;
  const [kind, setKind] = useState<PoiKind>(params?.kind ?? "fuel");
  const [state, setState] = useState<State>({ key: "", status: "loading" });
  const [retry, setRetry] = useState(0);
  const { selected } = useNearbyMarkers();

  const origin = here ? ([here.lat, here.lng] as LatLngTuple) : null;
  const key = `${kind}|${route ? "route" : origin?.join(",")}|${retry}`;
  useEffect(() => {
    if (!route && !origin) return;
    let live = true;
    setState({ key, status: "loading" });
    const p = route ? findAlong(kind, route) : findNear(kind, (origin as LatLngTuple)[0], (origin as LatLngTuple)[1]);
    p.then(
      (r) => live && setState(r.failed ? { key, status: "error" } : { key, status: "ok", items: r.items }),
      () => live && setState({ key, status: "error" }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const items = useMemo(() => (state.key === key && state.status === "ok" ? state.items : []), [state, key]);

  // Their markers on the map (drawn by PlacesLayer), and the view: them plus you, or the route.
  useEffect(() => {
    setNearbyMarkers({ items: items.map((it) => ({ ...refOf(it), key: it.key, poi: it.kind })), selected: null });
  }, [items]);
  useEffect(() => () => setNearbyMarkers({ items: [], selected: null }), []);
  useEffect(() => {
    const pts: MapPoint[] = origin && !route ? [{ lat: origin[0], lng: origin[1], kind: "start", label: "You" }] : [];
    const fit: LatLngTuple[] = route ? [...route] : [...(origin ? [origin] : []), ...items.map((it) => [it.lat, it.lng] as LatLngTuple)];
    setScene({
      route,
      points: pts,
      fit,
      markers: false,
      fitPadding:
        isDesktop || typeof window === "undefined" ? undefined : { topLeft: [32, 28], bottomRight: [32, Math.round(window.innerHeight * 0.64) + 20] },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, route, isDesktop, origin?.[0], origin?.[1]]);

  // Picked on the map: bring its row into view.
  useEffect(() => {
    if (selected) document.getElementById(`nearby-${selected}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);

  const pick = (it: NearbyItem) => {
    const on = selected === it.key;
    setNearbyMarkers({ items: items.map((x) => ({ ...refOf(x), key: x.key, poi: x.kind })), selected: on ? null : it.key });
    // Desktop: zoom to it. A phone keeps the fitted view (centering it would put it under the sheet);
    // its marker grows instead.
    if (!on && isDesktop) focus({ lat: it.lat, lng: it.lng, zoom: 15 });
  };

  const [one, many] = NOUN[kind];
  const title = route ? `${POI[kind].label} on the way${params?.routeTo ? ` to ${params.routeTo}` : ""}` : `${POI[kind].label} near you`;
  const loading = state.key !== key || state.status === "loading";

  return (
    <div className="flex flex-col gap-4 px-5 pt-3 pb-8 md:pt-6">
      <BackHeader onBack={back} label={route ? "Trip" : here ? `Near ${here.name}` : "Nearby"} />
      <div className="flex flex-col gap-1">
        <h1 className="m-0 text-[28px] leading-[1.1] font-bold tracking-[-0.02em]">{title}</h1>
        <span className="text-[13px] text-muted">
          {route ? "Within half a mile of your route, in the order you pass them (miles into the trip)." : "Closest first, as the crow flies."}
        </span>
      </div>
      <div className="no-scrollbar -mx-5 flex gap-2 overflow-x-auto px-5" role="group" aria-label="Show">
        {POI_KINDS.map((k) => (
          <FilterChip key={k} label={POI[k].label} selected={kind === k} onClick={() => setKind(k)} />
        ))}
      </div>

      {loading && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-busy="true" aria-label={`Finding ${many}`}>
          {[0, 1, 2].map((i) => (
            <li key={i} className="h-[58px] animate-pulse rounded-[14px] bg-card" />
          ))}
        </ul>
      )}
      {!loading && state.status === "error" && (
        <p className="m-0 flex flex-wrap items-baseline gap-x-2 text-[14px]" style={{ color: C.heavyText }} role="alert">
          <span>Couldn&apos;t load the map data for {many} right now.</span>
          <button type="button" onClick={() => setRetry((n) => n + 1)} className="cursor-pointer text-[14px] font-medium text-accent">
            Try again
          </button>
        </p>
      )}
      {!loading && state.status === "ok" && !items.length && (
        <p className="m-0 text-[14px] text-muted">
          No {many} {route ? "within half a mile of this route" : "within about 2.5 miles"} on the map.
        </p>
      )}
      {!loading && items.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label={title}>
          {items.map((it) => {
            const on = selected === it.key;
            const where = route ? (it.off < 100 ? "right on your route" : `${miles(it.off)} off your route`) : `${miles(it.off)} away`;
            // Along a route: how far into the trip; near you: how far from you.
            const dist = route ? `${miles(it.along ?? 0)} in` : miles(it.off);
            return (
              <li
                key={it.key}
                id={`nearby-${it.key}`}
                className="flex scroll-mt-4 flex-col rounded-[14px] bg-card"
                style={on ? { boxShadow: `inset 0 0 0 1px ${C.accent}` } : undefined}
              >
                <button
                  type="button"
                  onClick={() => pick(it)}
                  aria-expanded={on}
                  className="flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full" style={{ background: POI[it.kind].color }}>
                    <Icon d={POI[it.kind].icon} size={17} color={C.onAccent} width={2.4} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[15px] font-semibold text-ink">{it.name}</span>
                    <span className="truncate text-[12px] text-muted">
                      {route ? (it.name === it.sub ? where : `${it.sub} · ${where}`) : it.name === it.sub ? "No name on the map" : it.sub}
                    </span>
                  </span>
                  <span className="font-num shrink-0 text-[13px] text-soft">{dist}</span>
                </button>
                {on && (
                  <div className="border-t px-3 pt-2.5 pb-3" style={{ borderColor: C.line }}>
                    <PlaceCard place={refOf(it)} compact onDirections={() => go(tripTo(refOf(it)))} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="m-0 text-[12px] leading-snug text-muted">
        From OpenStreetMap map data: no prices, and we can&apos;t tell if a {one} is open or busy unless its hours are listed.
      </p>
    </div>
  );
}
