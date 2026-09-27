"use client";

/** Route choices on the map (MapScene.routes): the other routes dashed grey under the picked one (which TrafficMap
 * draws as the main route), and a label bubble on each ("18 min via I-610"). Tapping a dashed line or a bubble
 * picks that route. Both sit above the traffic lines, so a tap there never falls through to "Why it's slow". */

import L from "leaflet";
import { Fragment, useMemo, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Marker, Pane, Polyline, useMap, useMapEvents } from "react-leaflet";

import { useApp, type MapScene } from "@/components/app/AppContext";
import type { LatLngTuple } from "@/lib/types";
import { C, SHADOW } from "@/lib/theme";

type SceneRoute = NonNullable<MapScene["routes"]>[number];

/** Where to put each route's bubble, in screen space at the current zoom: on its own line, as far as possible from
 * the other lines (so it's clear which line it names), never on top of another bubble or the start / end markers.
 * The picked route goes first. */
function bubbleSpots(map: L.Map, routes: SceneRoute[], markers: LatLngTuple[]): (LatLngTuple | null)[] {
  const px = routes.map((r) => r.geometry.map((p) => map.latLngToLayerPoint(p)));
  const sample = (pts: L.Point[], n: number) => pts.filter((_, i) => i % Math.max(1, Math.floor(pts.length / n)) === 0);
  const placed: { x: number; y: number; w: number; h: number }[] = markers.map((m) => {
    const p = map.latLngToLayerPoint(m);
    return { x: p.x, y: p.y, w: 22, h: 22 };
  });
  const out: (LatLngTuple | null)[] = routes.map(() => null);
  const order = routes.map((_, i) => i).sort((a, b) => Number(routes[b].selected) - Number(routes[a].selected));
  for (const i of order) {
    const line = px[i];
    if (line.length < 2) continue;
    const others = px.flatMap((l, j) => (j === i ? [] : sample(l, 200)));
    const w = 7 * ((routes[i].time?.length ?? 0) + routes[i].label.length) + 30;
    const h = 26;
    let best = -Infinity;
    let at = Math.floor(line.length / 2);
    const from = Math.floor(line.length * 0.1);
    const to = Math.max(from + 1, Math.ceil(line.length * 0.9));
    for (let k = from; k < to; k += Math.max(1, Math.floor((to - from) / 60))) {
      const p = line[k];
      let clear = 80;
      for (const q of others) clear = Math.min(clear, Math.hypot(p.x - q.x, p.y - q.y));
      const hits = placed.some((b) => Math.abs(b.x - p.x) < (b.w + w) / 2 + 6 && Math.abs(b.y - p.y) < (b.h + h) / 2 + 4);
      const score = clear - (hits ? 1000 : 0) - Math.abs(k - line.length / 2) / line.length;
      if (score > best) {
        best = score;
        at = k;
      }
    }
    placed.push({ x: line[at].x, y: line[at].y, w, h });
    out[i] = routes[i].geometry[at];
  }
  return out;
}

function bubble(time: string | undefined, label: string, on: boolean) {
  const html = renderToStaticMarkup(
    <span
      style={{
        position: "absolute",
        transform: "translate(-50%, -50%)",
        display: "flex",
        alignItems: "baseline",
        gap: 5,
        padding: "4px 10px",
        borderRadius: 12,
        whiteSpace: "nowrap",
        fontFamily: "var(--font-figtree), system-ui, sans-serif",
        fontSize: 12,
        fontWeight: 500,
        cursor: "pointer",
        background: on ? C.accent : C.pop,
        color: on ? C.onAccent : C.soft,
        border: `1px solid ${on ? C.accent : C.popLine}`,
        boxShadow: SHADOW[1],
      }}
    >
      {time && <b style={{ fontWeight: 700, color: on ? C.onAccent : C.ink }}>{time}</b>}
      <span>{label}</span>
    </span>,
  );
  return L.divIcon({ html, className: "route-bubble", iconSize: [0, 0], iconAnchor: [0, 0] });
}

export default function RouteOptions() {
  const { scene } = useApp();
  const map = useMap();
  const [zoom, setZoom] = useState(() => map.getZoom());
  useMapEvents({ zoomend: () => setZoom(map.getZoom()) });
  const routes = scene?.routes;
  const points = scene?.points;
  const pick = scene?.pickRoute;
  // Screen positions: again after every zoom
  const spots = useMemo(
    () => (routes && routes.length > 1 ? bubbleSpots(map, routes, (points ?? []).map((p) => [p.lat, p.lng] as LatLngTuple)) : []),
    [routes, points, zoom, map],
  );
  if (!routes || routes.length < 2) return null;
  return (
    <>
      <Pane name="route-options" style={{ zIndex: 415 }}>
        {routes
          .filter((r) => !r.selected)
          .map((r) => (
            <Fragment key={r.id}>
              <Polyline positions={r.geometry} pathOptions={{ color: C.halo, weight: 9, opacity: 0.9 }} interactive={false} />
              <Polyline positions={r.geometry} pathOptions={{ color: C.alt, weight: 5, opacity: 0.95 }} interactive={false} />
              {/* An invisible wide line, easy to tap */}
              <Polyline
                positions={r.geometry}
                pathOptions={{ color: C.muted, weight: 22, opacity: 0 }}
                bubblingMouseEvents={false}
                eventHandlers={{ click: () => pick?.(r.id) }}
              />
            </Fragment>
          ))}
      </Pane>
      {/* Over the place names too (they're Leaflet tooltips, 650), under popups (700) */}
      <Pane name="route-bubbles" style={{ zIndex: 660 }}>
        {routes.map((r, i) =>
          spots[i] ? (
            <Marker
              key={`${r.id}-${r.selected}`}
              position={spots[i]}
              icon={bubble(r.time, r.label, r.selected)}
              title={`${r.time ? `${r.time} ` : ""}${r.label}${r.selected ? " (picked)" : ""}`}
              zIndexOffset={r.selected ? 100 : 0}
              eventHandlers={{
                click: () => pick?.(r.id),
                keypress: (e) => {
                  if (e.originalEvent.key !== "Enter" && e.originalEvent.key !== " ") return;
                  e.originalEvent.preventDefault();
                  pick?.(r.id);
                },
              }}
            />
          ) : null,
        )}
      </Pane>
    </>
  );
}
