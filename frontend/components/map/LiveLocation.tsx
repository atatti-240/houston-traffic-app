"use client";

/** Driving mode on the map: the blue you-are-here dot with a heading arrow and an accuracy circle, and the map
 * following it (dragging the map stops that until Recenter). Draws nothing unless driving. */

import L from "leaflet";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Circle, Marker, Pane, useMap, useMapEvents } from "react-leaflet";

import { drive, useDrive } from "@/components/drive/store";

const DOT = "#6E9BFF"; // as the map's static you-are-here dot
const HALO = "#3B6FD1";
const FOLLOW_ZOOM = 16;

function dotIcon(heading: number | null) {
  const arrow =
    heading === null
      ? ""
      : `<path d="M24 3 L31.5 17.5 L24 14.5 L16.5 17.5 Z" fill="${DOT}" stroke="#FFFFFF" stroke-width="1.6" stroke-linejoin="round"/>`;
  const html = `<svg width="48" height="48" viewBox="0 0 48 48" style="transform: rotate(${heading ?? 0}deg); filter: drop-shadow(0 1px 3px rgba(0,0,0,0.6))" aria-hidden="true">${arrow}<circle cx="24" cy="24" r="8" fill="${DOT}" stroke="#FFFFFF" stroke-width="3"/></svg>`;
  return L.divIcon({ html, className: "you-here", iconSize: [48, 48], iconAnchor: [24, 24] });
}

export default function LiveLocation() {
  const map = useMap();
  const active = useDrive((s) => s.active);
  const fix = useDrive((s) => s.fix);
  const follow = useDrive((s) => s.follow);
  const recenter = useDrive((s) => s.recenter);
  // Zoom in when following starts, until the map gets there; after that keep whatever zoom you pick
  const reached = useRef(false);
  const apply = useCallback(() => {
    const { active: on, follow: following, fix: f } = drive.get();
    if (!on || !following || !f) return;
    const zoom = reached.current ? map.getZoom() : Math.max(map.getZoom(), FOLLOW_ZOOM);
    map.setView([f.lat, f.lng], zoom, { animate: true });
  }, [map]);

  useMapEvents({
    dragstart: () => {
      if (drive.get().active) drive.setFollow(false);
    },
    zoomend: () => {
      if (map.getZoom() >= FOLLOW_ZOOM - 0.01) reached.current = true;
      // A zoom that was already animating (fitting the route) swallows ours: ask again once it's done
      else if (!reached.current) apply();
    },
  });

  useEffect(() => {
    if (!active) reached.current = false;
  }, [active]);
  useEffect(() => {
    reached.current = false;
  }, [recenter]);

  const lat = fix?.lat;
  const lng = fix?.lng;
  useEffect(() => {
    if (lat !== undefined && lng !== undefined) apply();
  }, [active, follow, lat, lng, recenter, apply]);

  const heading = fix?.heading == null ? null : Math.round(fix.heading / 5) * 5;
  const icon = useMemo(() => dotIcon(heading), [heading]);

  if (!active || !fix) return null;
  return (
    <Pane name="you-here" style={{ zIndex: 650 }}>
      <Circle
        center={[fix.lat, fix.lng]}
        radius={Math.max(5, Math.min(fix.accuracy, 5000))}
        interactive={false}
        pathOptions={{ color: HALO, weight: 1, opacity: 0.6, fillColor: HALO, fillOpacity: 0.18 }}
      />
      <Marker position={[fix.lat, fix.lng]} icon={icon} interactive={false} keyboard={false} />
    </Pane>
  );
}
