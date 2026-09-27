"use client";

/** The live traffic map (Leaflet, dark): road lines by level, cause markers with the design's
 * tooltip card, plus whatever the current screen put in the map scene (route, road, points). */

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CircleMarker, MapContainer, Marker, Pane, Polyline, Popup, Tooltip, useMap, useMapEvents } from "react-leaflet";

import { useApp, type MapHandle, type MapScene } from "@/components/app/AppContext";
import RouteOptions from "@/components/map/RouteOptions";
import VectorBasemap from "@/components/map/VectorBasemap";
import { camName } from "@/lib/format";
import { CAUSE, C, LEVEL, type CauseKind } from "@/lib/theme";
import type { LatLngTuple, Slowdown } from "@/lib/types";

export const HOUSTON_CENTER: LatLngTuple = [29.7604, -95.3698];

/** Shift a line to the right of travel so both directions of a road are visible: each point
 * moves along the average of its neighbouring segments' right-hand normals (curves stay curves). */
export function offsetLine(geom: LatLngTuple[], meters = 55): LatLngTuple[] {
  if (geom.length < 2) return geom;
  const cos = Math.cos((geom[0][0] * Math.PI) / 180);
  const k = meters / 111_320;
  const normals = geom.slice(1).map((b, i) => {
    const a = geom[i];
    const dx = (b[1] - a[1]) * cos;
    const dy = b[0] - a[0];
    const len = Math.hypot(dx, dy) || 1;
    return [-dx / len, dy / len] as const; // right of travel: (dLat, dLng scaled)
  });
  return geom.map(([lat, lng], i) => {
    const prev = normals[Math.max(0, i - 1)];
    const next = normals[Math.min(normals.length - 1, i)];
    let nLat = prev[0] + next[0];
    let nLng = prev[1] + next[1];
    const len = Math.hypot(nLat, nLng) || 1;
    nLat /= len;
    nLng /= len;
    return [lat + nLat * k, lng + (nLng * k) / cos];
  });
}

function Register() {
  const map = useMap();
  const { registerMap } = useApp();
  useEffect(() => {
    registerMap(map as unknown as MapHandle);
    const t = setTimeout(() => map.invalidateSize(), 50);
    return () => {
      clearTimeout(t);
      registerMap(null);
    };
  }, [map, registerMap]);
  // Keep the map sized right when its container changes (panel open/close, rotation).
  useEffect(() => {
    const el = map.getContainer();
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(el);
    return () => ro.disconnect();
  }, [map]);
  return null;
}

// Default room around a fitted scene: extra at the top for the legend and the demo bar.
const FIT_PADDING: NonNullable<MapScene["fitPadding"]> = { topLeft: [56, 76], bottomRight: [56, 56] };

function FitScene({ fit, padding = FIT_PADDING }: { fit?: LatLngTuple[]; padding?: MapScene["fitPadding"] }) {
  const map = useMap();
  const key = fit ? JSON.stringify([fit, padding]) : "";
  useEffect(() => {
    if (!fit || !fit.length) return;
    if (fit.length === 1) map.setView(fit[0], 14);
    else map.fitBounds(fit, { paddingTopLeft: padding.topLeft, paddingBottomRight: padding.bottomRight, maxZoom: 14 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, map]);
  return null;
}

function ClickAway() {
  const { select } = useApp();
  useMapEvents({ click: () => select(null) });
  return null;
}

function markerIcon(kind: CauseKind, selected: boolean, ring: string) {
  const size = selected ? 38 : 32;
  const html = renderToStaticMarkup(
    <span
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: C.marker,
        border: `2px solid ${C.onAccent}`,
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: selected ? `0 0 0 3px ${ring}, 0 3px 10px rgba(0,0,0,0.6)` : "0 2px 8px rgba(0,0,0,0.6)",
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.onAccent} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d={CAUSE[kind].icon} />
      </svg>
    </span>,
  );
  return L.divIcon({ html, className: "cause-icon", iconSize: [44, 44], iconAnchor: [22, 22] });
}

/** The design's cause tooltip card. */
export function CauseCard({ s, onWhy }: { s: Slowdown; onWhy?: () => void }) {
  const kind = (s.kind ?? "rush") as CauseKind;
  const lv = LEVEL[s.level];
  return (
    <div style={{ width: 248, display: "flex", flexDirection: "column", gap: 6, fontFamily: "var(--font-grotesk), system-ui, sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 22, height: 22, borderRadius: 11, background: C.marker, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={C.onAccent} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d={CAUSE[kind].icon} />
          </svg>
        </span>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: C.muted }}>{s.label ?? CAUSE[kind].label}</span>
      </div>
      <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.25, color: C.ink }}>{s.title}</div>
      <div style={{ fontSize: 13, fontWeight: 500, color: C.soft }}>
        {s.road} · {s.place}
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.4, color: C.muted }}>{s.detail}</div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 2 }}>
        <span style={{ padding: "3px 10px", borderRadius: 10, fontSize: 12, fontWeight: 600, background: lv.color, color: lv.fg }}>
          {s.closed ? "Closed" : `${lv.label} traffic`}
        </span>
        <span className="font-num" style={{ fontSize: 15, color: C.ink }}>
          +{s.delay_min} min
        </span>
      </div>
      {onWhy && (
        <button
          type="button"
          onClick={onWhy}
          style={{
            marginTop: 4,
            height: 36,
            borderRadius: 18,
            border: 0,
            background: C.accent,
            color: C.onAccent,
            fontWeight: 600,
            fontSize: 14,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Why it&apos;s slow →
        </button>
      )}
    </div>
  );
}

function CauseMarkers() {
  const { slowdowns, layers, causeFilter, selected, mapTime, scene } = useApp();
  const items = useMemo(
    () => (slowdowns?.items ?? []).filter((s) => s.highlight && s.kind && (!causeFilter || s.kind === causeFilter)),
    [slowdowns, causeFilter],
  );
  // The marker picked with the keyboard: its popup takes focus when it opens.
  const byKey = useRef<string | null>(null);
  if (!layers.causes || mapTime || scene?.markers === false) return null;
  return (
    <>
      {items.map((s) => (
        <CauseMarker key={s.id} s={s} sel={selected === s.id} byKey={byKey} />
      ))}
    </>
  );
}

/** One cause icon. Its popup opens (and pans into view) once per selection: the app re-renders every few
 * seconds, and the popup's autoPan would otherwise pull the map back to it each time. */
function CauseMarker({ s, sel, byKey }: { s: Slowdown; sel: boolean; byKey: RefObject<string | null> }) {
  const { select, go } = useApp();
  const marker = useRef<L.Marker>(null);
  useEffect(() => {
    if (!sel) return;
    const t = setTimeout(() => marker.current?.openPopup(), 0);
    return () => clearTimeout(t);
  }, [sel]);
  const shown = useCallback(
    (card: HTMLElement) => {
      const p = marker.current?.getPopup();
      if (p) {
        p.options.autoPan = true;
        p.update();
        p.options.autoPan = false;
      }
      if (byKey.current === s.id) {
        byKey.current = null;
        card.querySelector("button")?.focus({ preventScroll: true });
      }
    },
    [s.id, byKey],
  );
  const card = useMemo(() => <PopupCard s={s} onWhy={() => go({ name: "why", id: s.id })} onShown={shown} />, [s, go, shown]);
  return (
    <Marker
      key={String(sel)}
      ref={marker}
      position={[s.lat, s.lng]}
      icon={markerIcon(s.kind as CauseKind, sel, LEVEL[s.level].color)}
      zIndexOffset={sel ? 1000 : 0}
      title={`${s.label}: ${s.title}, ${s.level} traffic, +${s.delay_min} min`}
      eventHandlers={{
        click: () => select(s.id),
        // Enter / Space on a focused icon (Leaflet makes it a button but only handles clicks)
        keypress: (e) => {
          if (e.originalEvent.key !== "Enter" && e.originalEvent.key !== " ") return;
          e.originalEvent.preventDefault();
          if (sel) return;
          byKey.current = s.id;
          select(s.id);
        },
        popupclose: () => sel && select(null),
      }}
    >
      {!sel && (
        <Tooltip direction="top" offset={[0, -18]} opacity={1} className="cause-tip">
          <CauseCard s={s} />
        </Tooltip>
      )}
      {sel && (
        <Popup closeButton={false} autoPan={false} offset={[0, -14]} className="cause-popup">
          {card}
        </Popup>
      )}
    </Marker>
  );
}

/** The selected marker's card; tells its marker once it is on the page (to pan to it and maybe focus it). */
function PopupCard({ s, onWhy, onShown }: { s: Slowdown; onWhy: () => void; onShown: (card: HTMLElement) => void }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (el.current) onShown(el.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div ref={el}>
      <CauseCard s={s} onWhy={onWhy} />
    </div>
  );
}

/**
 * `interactive` (default): the app's one main map (registers itself for zoom/focus, shows the
 * screen's scene and cause markers). `interactive={false}`: a static preview (e.g. the "You're
 * in ..." card) centred on `center` at `zoom`, traffic lines only.
 */
export default function TrafficMap({
  interactive = true,
  center,
  zoom = 13,
}: {
  interactive?: boolean;
  center?: LatLngTuple;
  zoom?: number;
}) {
  const app = useApp();
  const { segments, levels, places, here, layers, live, go } = app;
  const scene = interactive ? app.scene : null;
  return (
    <MapContainer
      center={center ?? HOUSTON_CENTER}
      zoom={center ? zoom : 11}
      className="h-full w-full"
      zoomControl={false}
      attributionControl
      dragging={interactive}
      scrollWheelZoom={interactive}
      doubleClickZoom={interactive}
      touchZoom={interactive}
      keyboard={interactive}
    >
      <VectorBasemap places={interactive} />
      {interactive && <Register />}
      {interactive && <ClickAway />}
      {interactive && <FitScene fit={scene?.fit} padding={scene?.fitPadding} />}
      {!interactive && center && <Recenter center={center} zoom={zoom} />}

      {/* Traffic: each direction offset to its right, dark casing under the colored line */}
      {segments.map((s) => {
        const geom = offsetLine(s.geometry);
        const w = s.road_class === "freeway" ? 5 : 3.5;
        return (
          <Polyline key={`k-${s.id}`} positions={geom} pathOptions={{ color: "#0E1015", weight: w + 3, opacity: 0.9 }} interactive={false} />
        );
      })}
      {segments.map((s) => {
        const geom = offsetLine(s.geometry);
        const lv = levels[s.id] ?? "light";
        const w = s.road_class === "freeway" ? 5 : 3.5;
        return (
          <Polyline
            key={`c-${s.id}`}
            positions={geom}
            pathOptions={{ color: LEVEL[lv].color, weight: w, opacity: 0.95 }}
            eventHandlers={interactive ? { click: () => go({ name: "why", id: s.id }) } : undefined}
          >
            {interactive && (
              <Tooltip sticky className="dark-tip">
                {s.name} ({s.direction}) · {LEVEL[lv].label}
              </Tooltip>
            )}
          </Polyline>
        );
      })}

      {/* Selected road (Why it's slow) */}
      {scene?.highlight && (
        <>
          <Polyline positions={offsetLine(scene.highlight)} pathOptions={{ color: "#FFFFFF", weight: 14, opacity: 0.18 }} interactive={false} />
          <Polyline positions={offsetLine(scene.highlight)} pathOptions={{ color: "#FFFFFF", weight: 3, opacity: 0.9 }} interactive={false} />
        </>
      )}

      {/* Routes: own panes over the traffic, the dashed alternative always under the main route (within a pane,
          whichever line is added last is drawn on top) */}
      <Pane name="alt-route" style={{ zIndex: 410 }}>
        {scene?.alternative && (
          <Polyline positions={scene.alternative} pathOptions={{ color: C.muted, weight: 6, opacity: 0.7, dashArray: "8 8" }} interactive={false} />
        )}
      </Pane>
      {interactive && <RouteOptions />}
      <Pane name="route" style={{ zIndex: 420 }}>
        {(scene?.legs ?? (scene?.route ? [scene.route] : [])).map((leg, i) => (
          <span key={`r-${i}`}>
            <Polyline positions={leg} pathOptions={{ color: "#0E1015", weight: 12, opacity: 0.9 }} interactive={false} />
            <Polyline positions={leg} pathOptions={{ color: C.accent, weight: 7, opacity: 1 }} interactive={false} />
          </span>
        ))}
      </Pane>

      {/* Crossings layer */}
      {interactive && layers.crossings &&
        (live?.crossings ?? []).map((c) => (
          <CircleMarker
            key={`x-${c.id}`}
            center={[c.lat, c.lng]}
            radius={c.status === "blocked" ? 9 : 6}
            className={c.status === "blocked" ? "pulse" : undefined}
            pathOptions={{
              color: c.status === "blocked" ? C.heavy : "#0E1015",
              weight: 2,
              fillColor: c.status === "blocked" ? "#11141A" : C.moderate,
              fillOpacity: 1,
            }}
          >
            <Tooltip className="dark-tip">
              {c.street}: {c.status === "blocked" ? `blocked, ~${c.time_to_clear_min} min` : `${Math.round((c.p_block_now ?? 0) * 100)}% chance of a train now`}
            </Tooltip>
          </CircleMarker>
        ))}

      {/* Cameras layer */}
      {interactive && layers.cameras &&
        (live?.cameras ?? []).map((cam) => (
          <CircleMarker
            key={`cam-${cam.id}`}
            center={[cam.lat, cam.lng]}
            radius={6}
            bubblingMouseEvents={false}
            pathOptions={{ color: "#0E1015", weight: 2, fillColor: C.accent, fillOpacity: 1 }}
            eventHandlers={{ click: () => go({ name: "cameras", area: cam.area, camId: cam.id }) }}
          >
            <Tooltip className="dark-tip">📷 {camName(cam.name)}</Tooltip>
          </CircleMarker>
        ))}

      {/* Place labels */}
      {places.map((p) => (
        <CircleMarker key={`p-${p.id}`} center={[p.lat, p.lng]} radius={2} interactive={false} pathOptions={{ color: "#9CA3B0", weight: 0, fillColor: "#9CA3B0", fillOpacity: 0.8 }}>
          <Tooltip permanent direction="right" offset={[4, 0]} className="place-label">
            {p.name.replace(" / Uptown", "")}
          </Tooltip>
        </CircleMarker>
      ))}

      {/* You are here */}
      {here && (
        <>
          <CircleMarker center={[here.lat, here.lng]} radius={16} interactive={false} pathOptions={{ color: "#3B6FD1", weight: 0, fillColor: "#3B6FD1", fillOpacity: 0.25 }} />
          <CircleMarker center={[here.lat, here.lng]} radius={6} interactive={false} pathOptions={{ color: "#FFFFFF", weight: 2, fillColor: "#6E9BFF", fillOpacity: 1 }} />
        </>
      )}

      {/* Scene points: start / stops / end (own pane: above the route lines and cause icons) */}
      <Pane name="scene-points" style={{ zIndex: 640 }}>
        {(scene?.points ?? []).map((pt, i) => (
          <CircleMarker
            key={`pt-${i}`}
            center={[pt.lat, pt.lng]}
            radius={pt.kind === "stop" ? 8 : 9}
            pathOptions={{
              color: "#FFFFFF",
              weight: 3,
              fillColor: pt.kind === "start" ? C.light : pt.kind === "end" ? C.heavy : C.accent,
              fillOpacity: 1,
            }}
          >
            {pt.label && (
              <Tooltip direction="top" className="dark-tip">
                {pt.label}
              </Tooltip>
            )}
          </CircleMarker>
        ))}
      </Pane>

      {interactive && <CauseMarkers />}
    </MapContainer>
  );
}

function Recenter({ center, zoom }: { center: LatLngTuple; zoom: number }) {
  const map = useMap();
  const key = `${center[0]},${center[1]},${zoom}`;
  useEffect(() => {
    map.setView(center, zoom, { animate: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, map]);
  return null;
}
