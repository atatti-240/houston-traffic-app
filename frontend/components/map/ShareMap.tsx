"use client";

/** The map on a Share ETA link: the street map, the shared route and its two ends. It stands
 * alone (no AppProvider, no traffic layer, no places): a link shows this trip and nothing else. */

import "leaflet/dist/leaflet.css";
import "maplibre-gl/dist/maplibre-gl.css";
import "@maplibre/maplibre-gl-leaflet";
import L from "leaflet";
import { setWorkerUrl, type Map as LibreMap } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { CircleMarker, MapContainer, Pane, Polyline, TileLayer, Tooltip, useMap } from "react-leaflet";

import { ATTRIBUTION, RASTER_ATTRIBUTION, STYLE, WORKER, hasWebGL, rasterUrl, restyle } from "@/components/map/basemapStyle";
import { C } from "@/lib/theme";
import { useTheme } from "@/lib/themeMode";
import type { LatLngTuple } from "@/lib/types";

const HOUSTON: LatLngTuple = [29.7604, -95.3698];

/** The same street map and colors as the app's map (basemapStyle.ts), without its places. */
function Streets() {
  const map = useMap();
  const theme = useTheme();
  const themeRef = useRef(theme);
  const [webgl] = useState(hasWebGL);
  const [styled, setStyled] = useState<LibreMap | null>(null);
  useEffect(() => {
    if (!webgl) return;
    setWorkerUrl(new URL(WORKER, window.location.origin).href);
    const layer = L.maplibreGL({ style: STYLE, attributionControl: false });
    layer.getAttribution = () => ATTRIBUTION;
    layer.addTo(map);
    const gl = layer.getMaplibreMap();
    const onStyle = () => {
      restyle(gl, themeRef.current);
      setStyled(gl);
    };
    gl.on("style.load", onStyle);
    return () => {
      gl.off("style.load", onStyle);
      setStyled(null);
      layer.remove();
    };
  }, [map, webgl]);
  useEffect(() => {
    themeRef.current = theme;
    if (styled) restyle(styled, theme);
  }, [theme, styled]);
  if (webgl) return null;
  return <TileLayer key={theme} attribution={RASTER_ATTRIBUTION} url={rasterUrl(theme)} />;
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
            <Polyline positions={route} pathOptions={{ color: C.routeCasing, weight: 10, opacity: 1 }} interactive={false} />
            <Polyline positions={route} pathOptions={{ color: C.route, weight: 6, opacity: 1 }} interactive={false} />
          </>
        )}
      </Pane>
      <Pane name="share-points" style={{ zIndex: 640 }}>
        {start && (
          <CircleMarker center={start} radius={8} interactive={false} pathOptions={{ color: C.halo, weight: 3, fillColor: C.light, fillOpacity: 1 }} />
        )}
        {end && (
          <CircleMarker center={end} radius={9} pathOptions={{ color: C.halo, weight: 3, fillColor: C.heavy, fillOpacity: 1 }}>
            {endLabel && (
              <Tooltip permanent direction="top" offset={[0, -10]} className="dark-tip">
                {/* Cut short: a long name over a pin near the edge would run off the map */}
                <span className="block max-w-[150px] truncate">{endLabel}</span>
              </Tooltip>
            )}
          </CircleMarker>
        )}
      </Pane>
    </MapContainer>
  );
}
