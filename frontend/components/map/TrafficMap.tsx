"use client";

/** The live traffic map (Leaflet, dark): road lines by level, cause markers with the design's
 * tooltip card, plus whatever the current screen put in the map scene (route, road, points). */

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { useEffect, useMemo } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CircleMarker, MapContainer, Marker, Polyline, Popup, TileLayer, Tooltip, useMap, useMapEvents } from "react-leaflet";

import { useApp, type MapHandle } from "@/components/app/AppContext";
import { CAUSE, C, LEVEL, type CauseKind } from "@/lib/theme";
import type { LatLngTuple, Slowdown } from "@/lib/types";

export const HOUSTON_CENTER: LatLngTuple = [29.7604, -95.3698];

/** Shift a line to the right of travel so both directions of a road are visible. */
export function offsetLine(geom: LatLngTuple[], meters = 55): LatLngTuple[] {
  if (geom.length < 2) return geom;
  const [a, b] = [geom[0], geom[geom.length - 1]];
  const cos = Math.cos((a[0] * Math.PI) / 180);
  const dx = (b[1] - a[1]) * cos;
  const dy = b[0] - a[0];
  const len = Math.hypot(dx, dy) || 1;
  const k = meters / 111_320;
  const dLat = (-dx / len) * k;
  const dLng = ((dy / len) * k) / cos;
  return geom.map(([lat, lng]) => [lat + dLat, lng + dLng]);
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

function FitScene({ fit }: { fit?: LatLngTuple[] }) {
  const map = useMap();
  const key = fit ? JSON.stringify(fit) : "";
  useEffect(() => {
    if (!fit || !fit.length) return;
    if (fit.length === 1) map.setView(fit[0], 14);
    else map.fitBounds(fit, { padding: [56, 56], maxZoom: 14 });
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
  const { slowdowns, layers, causeFilter, selected, select, go, mapTime, scene } = useApp();
  const items = useMemo(
    () => (slowdowns?.items ?? []).filter((s) => s.highlight && s.kind && (!causeFilter || s.kind === causeFilter)),
    [slowdowns, causeFilter],
  );
  if (!layers.causes || mapTime || scene?.markers === false) return null;
  return (
    <>
      {items.map((s) => {
        const sel = selected === s.id;
        return (
          <Marker
            key={`${s.id}-${sel}`}
            position={[s.lat, s.lng]}
            icon={markerIcon(s.kind as CauseKind, sel, LEVEL[s.level].color)}
            zIndexOffset={sel ? 1000 : 0}
            title={`${s.label}: ${s.title}, ${s.level} traffic, +${s.delay_min} min`}
            ref={sel ? (m) => void (m && setTimeout(() => m.openPopup(), 0)) : undefined}
            eventHandlers={{
              click: () => select(s.id),
              popupclose: () => sel && select(null),
            }}
          >
            {!sel && (
              <Tooltip direction="top" offset={[0, -18]} opacity={1} className="cause-tip">
                <CauseCard s={s} />
              </Tooltip>
            )}
            {sel && (
              <Popup closeButton={false} autoPan offset={[0, -14]} className="cause-popup">
                <CauseCard s={s} onWhy={() => go({ name: "why", id: s.id })} />
              </Popup>
            )}
          </Marker>
        );
      })}
    </>
  );
}

export default function TrafficMap({ interactive = true }: { interactive?: boolean }) {
  const { segments, levels, scene, places, here, layers, live, go, select } = useApp();
  return (
    <MapContainer
      center={HOUSTON_CENTER}
      zoom={11}
      className="h-full w-full"
      zoomControl={false}
      attributionControl
      dragging={interactive}
      scrollWheelZoom={interactive}
      doubleClickZoom={interactive}
      touchZoom={interactive}
      keyboard={interactive}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
        url="https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png"
      />
      <Register />
      <ClickAway />
      <FitScene fit={scene?.fit} />

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

      {/* Routes */}
      {scene?.alternative && (
        <Polyline positions={scene.alternative} pathOptions={{ color: C.muted, weight: 6, opacity: 0.7, dashArray: "8 8" }} interactive={false} />
      )}
      {(scene?.legs ?? (scene?.route ? [scene.route] : [])).map((leg, i) => (
        <span key={`r-${i}`}>
          <Polyline positions={leg} pathOptions={{ color: "#0E1015", weight: 12, opacity: 0.9 }} interactive={false} />
          <Polyline positions={leg} pathOptions={{ color: C.accent, weight: 7, opacity: 1 }} interactive={false} />
        </span>
      ))}

      {/* Crossings layer */}
      {layers.crossings &&
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
      {layers.cameras &&
        (live?.cameras ?? []).map((cam) => (
          <CircleMarker
            key={`cam-${cam.id}`}
            center={[cam.lat, cam.lng]}
            radius={6}
            bubblingMouseEvents={false}
            pathOptions={{ color: "#0E1015", weight: 2, fillColor: C.accent, fillOpacity: 1 }}
            eventHandlers={{ click: () => go({ name: "cameras", area: cam.area, camId: cam.id }) }}
          >
            <Tooltip className="dark-tip">📷 {cam.name}</Tooltip>
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

      {/* Scene points: start / stops / end */}
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

      {interactive && <CauseMarkers />}
      {!interactive && <DeselectOnMount select={select} />}
    </MapContainer>
  );
}

function DeselectOnMount({ select }: { select: (id: string | null) => void }) {
  useEffect(() => select(null), [select]);
  return null;
}
