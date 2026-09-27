"use client";

/** The map on a Share ETA link: the dark street map, the shared route and its two ends. It stands
 * alone (no AppProvider, no traffic layer, no places): a link shows this trip and nothing else. */

import "leaflet/dist/leaflet.css";
import "maplibre-gl/dist/maplibre-gl.css";
import "@maplibre/maplibre-gl-leaflet";
import L from "leaflet";
import { setWorkerUrl, type Map as LibreMap } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { CircleMarker, MapContainer, Pane, Polyline, TileLayer, Tooltip, useMap } from "react-leaflet";

import { C } from "@/lib/theme";
import type { LatLngTuple } from "@/lib/types";

const HOUSTON: LatLngTuple = [29.7604, -95.3698];
// The same free street map and colors as the app's map (components/map/VectorBasemap.tsx).
const STYLE = "https://tiles.openfreemap.org/styles/dark";
const WORKER = "/maplibre/maplibre-gl-worker.mjs";
const ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>';
const BG = "#171A21";
const PAINT: [string, string, string | number][] = [
  ["background", "background-color", BG],
  ["water", "fill-color", "#10131A"],
  ["landuse_park", "fill-color", "#1A2024"],
  ["landcover_wood", "fill-color", "#1A2024"],
  ["landuse_residential", "fill-opacity", 0],
  ["building", "fill-color", "#1D2129"],
  ["highway_minor", "line-color", "#2A2F3A"],
  ["highway_path", "line-color", "#2A2F3A"],
  ["highway_major_inner", "line-color", "#333948"],
  ["highway_major_subtle", "line-color", "#333948"],
  ["highway_motorway_inner", "line-color", "#333948"],
  ["highway_motorway_subtle", "line-color", "#333948"],
  ["highway_major_casing", "line-color", BG],
  ["highway_motorway_casing", "line-color", BG],
];

function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

function restyle(m: LibreMap) {
  for (const [layer, prop, value] of PAINT) {
    if (m.getLayer(layer)) m.setPaintProperty(layer, prop as Parameters<LibreMap["setPaintProperty"]>[1], value);
  }
}

function Streets() {
  const map = useMap();
  const [webgl] = useState(hasWebGL);
  useEffect(() => {
    if (!webgl) return;
    setWorkerUrl(new URL(WORKER, window.location.origin).href);
    const layer = L.maplibreGL({ style: STYLE, attributionControl: false });
    layer.getAttribution = () => ATTRIBUTION;
    layer.addTo(map);
    const gl = layer.getMaplibreMap();
    const onStyle = () => restyle(gl);
    gl.on("style.load", onStyle);
    return () => {
      gl.off("style.load", onStyle);
      layer.remove();
    };
  }, [map, webgl]);
  if (webgl) return null;
  return (
    <TileLayer
      attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
      url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
    />
  );
}

/** Fit the route into the part of the map that isn't under the panel (`bottom` px on a phone). Only
 * again when the route changes or the panel grows or shrinks a lot, so a look around isn't undone. */
function Fit({ points, bottom }: { points: LatLngTuple[]; bottom: number }) {
  const map = useMap();
  const fitted = useRef<{ key: string; bottom: number } | null>(null);
  const key = JSON.stringify([points[0], points[points.length - 1], points.length]);
  useEffect(() => {
    if (points.length < 2) return;
    const last = fitted.current;
    if (last && last.key === key && Math.abs(last.bottom - bottom) < 60) return;
    fitted.current = { key, bottom };
    map.invalidateSize();
    map.fitBounds(points, { paddingTopLeft: [56, 64], paddingBottomRight: [56, bottom + 32], maxZoom: 15 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, bottom, map]);
  // Keep the map sized right when its box changes (rotation, desktop <-> phone layout).
  useEffect(() => {
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(map.getContainer());
    return () => ro.disconnect();
  }, [map]);
  return null;
}

export default function ShareMap({
  route,
  end,
  endLabel,
  bottom = 0,
}: {
  route: LatLngTuple[] | null;
  end: LatLngTuple | null;
  endLabel?: string;
  /** Room to leave at the bottom (px) for a sheet over the map */
  bottom?: number;
}) {
  const start = route?.[0];
  const fit = route ? [...route, ...(end ? [end] : [])] : [];
  // Quarter zoom steps: the route fills the strip above a phone sheet instead of snapping a whole level out.
  return (
    <MapContainer center={HOUSTON} zoom={11} zoomSnap={0.25} className="h-full w-full" zoomControl={false} attributionControl>
      <Streets />
      <Fit points={fit} bottom={bottom} />
      <Pane name="share-route" style={{ zIndex: 420 }}>
        {route && (
          <>
            <Polyline positions={route} pathOptions={{ color: "#0E1015", weight: 12, opacity: 0.9 }} interactive={false} />
            <Polyline positions={route} pathOptions={{ color: C.accent, weight: 7, opacity: 1 }} interactive={false} />
          </>
        )}
      </Pane>
      <Pane name="share-points" style={{ zIndex: 640 }}>
        {start && (
          <CircleMarker center={start} radius={8} interactive={false} pathOptions={{ color: "#FFFFFF", weight: 3, fillColor: C.light, fillOpacity: 1 }} />
        )}
        {end && (
          <CircleMarker center={end} radius={9} pathOptions={{ color: "#FFFFFF", weight: 3, fillColor: C.heavy, fillOpacity: 1 }}>
            {endLabel && (
              <Tooltip permanent direction="top" offset={[0, -10]} className="dark-tip">
                {endLabel}
              </Tooltip>
            )}
          </CircleMarker>
        )}
      </Pane>
    </MapContainer>
  );
}
