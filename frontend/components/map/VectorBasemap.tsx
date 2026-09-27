"use client";

/**
 * Street map under the traffic: OpenFreeMap's free vector tiles (OpenStreetMap data, no key), drawn
 * by MapLibre inside the Leaflet map so every overlay keeps working. Colored like Google Maps in the
 * light or dark theme (basemapStyle.ts) and repainted in place when the theme changes. Falls back to
 * raster tiles when the browser has no WebGL.
 */

import "maplibre-gl/dist/maplibre-gl.css";
import "@maplibre/maplibre-gl-leaflet";
import L from "leaflet";
import { setWorkerUrl, type ExpressionSpecification, type Map as LibreMap } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { TileLayer, useMap } from "react-leaflet";
import {
  ATTRIBUTION,
  BASEMAP,
  RASTER_ATTRIBUTION,
  STYLE,
  WORKER,
  hasWebGL,
  placeColor,
  placeCss,
  placeKindOf,
  rasterUrl,
  restyle,
} from "@/components/map/basemapStyle";
import { HIGHLIGHT_LAYERS, installPoiLayers, restylePoiLayers, usePoiHighlights } from "@/components/places/poiLayers";
import { POI, osmRef } from "@/components/places/pois";
import { pickPlace, type PoiKind } from "@/components/places/store";
import { useTheme, type Theme } from "@/lib/themeMode";
import type { PlaceRef } from "@/lib/types";

// Places (shops, food, parks...): a dot colored by kind with its name, like Google Maps. Bigger places
// (lower OpenMapTiles rank) show up first as you zoom in.
const HIDDEN = ["bus", "parking", "entrance", "bicycle", "bicycle_rental", "toilets", "drinking_water", "information", "atm"];
const POI_BANDS: [string, number, number, number][] = [
  // [id suffix, from rank, to rank (exclusive), minzoom]
  ["1", 1, 4, 14],
  ["2", 4, 10, 15],
  ["3", 10, 20, 16],
  ["4", 20, 1000, 17],
];
const POI_LAYERS = POI_BANDS.map(([id]) => `poi-dot-${id}`);
const NAME_LAYERS = POI_BANDS.map(([id]) => `poi-name-${id}`);

function addPlaces(m: LibreMap) {
  if (!m.getSource("openmaptiles") || m.getLayer(POI_LAYERS[0])) return;
  for (const [id, lo, hi, minzoom] of POI_BANDS) {
    const filter: ExpressionSpecification = [
      "all",
      ["==", ["geometry-type"], "Point"],
      ["has", "name"],
      ["!", ["in", ["get", "class"], ["literal", HIDDEN]]],
      [">=", ["get", "rank"], lo],
      ["<", ["get", "rank"], hi],
    ];
    const base = { source: "openmaptiles", "source-layer": "poi", minzoom, filter } as const;
    m.addLayer({ ...base, id: `poi-dot-${id}`, type: "circle", paint: { "circle-radius": 4, "circle-stroke-width": 1.5 } });
    m.addLayer({
      ...base,
      id: `poi-name-${id}`,
      type: "symbol",
      layout: {
        "text-field": ["coalesce", ["get", "name_en"], ["get", "name"]],
        "text-font": ["Noto Sans Regular"],
        "text-size": 11.5,
        "text-max-width": 8,
        "text-variable-anchor": ["left", "right", "top"],
        "text-radial-offset": 0.7,
        "text-justify": "auto",
      },
      paint: { "text-halo-width": 1.4 },
    });
  }
}

/** The place dots and names for a theme. */
function restylePlaces(m: LibreMap, theme: Theme) {
  const color = placeColor(theme);
  const halo = BASEMAP[theme].halo;
  for (const id of POI_LAYERS) {
    if (!m.getLayer(id)) continue;
    m.setPaintProperty(id, "circle-color", color);
    m.setPaintProperty(id, "circle-stroke-color", halo);
  }
  for (const id of NAME_LAYERS) {
    if (!m.getLayer(id)) continue;
    m.setPaintProperty(id, "text-color", color);
    m.setPaintProperty(id, "text-halo-color", halo);
  }
}

function placeAt(m: LibreMap, lat: number, lng: number): PlaceRef | null {
  const p = m.project([lng, lat]);
  const hits = m.queryRenderedFeatures(
    [
      [p.x - 10, p.y - 10],
      [p.x + 10, p.y + 10],
    ],
    { layers: [...HIGHLIGHT_LAYERS, ...POI_LAYERS].filter((id) => m.getLayer(id)) },
  );
  const f = hits[0];
  if (!f || f.geometry.type !== "Point") return null;
  const [plng, plat] = f.geometry.coordinates;
  // Our gas / EV / parking highlights carry their own props (see poiLayers.ts).
  if (HIGHLIGHT_LAYERS.includes(f.layer.id)) {
    const h = f.properties as { name: string; sub: string; osm: string; kind: PoiKind };
    return { lat: plat, lng: plng, name: h.name, kind: h.sub, osm: h.osm || null, color: POI[h.kind]?.color };
  }
  const props = f.properties as { name?: string; name_en?: string; class?: string; subclass?: string };
  const sub = (props.subclass || props.class || "place").replace(/_/g, " ");
  return {
    lat: plat,
    lng: plng,
    name: props.name_en || props.name || "Place",
    kind: sub.charAt(0).toUpperCase() + sub.slice(1),
    color: placeCss(placeKindOf(props.class ?? "")),
    osm: osmRef(typeof f.id === "number" ? f.id : Number(f.id)),
  };
}

/** `places`: show shops and places (tap one for its card: hours, phone, directions) and the nearby
 * gas / EV / parking highlights. Off for small static previews. */
export default function VectorBasemap({ places = false }: { places?: boolean }) {
  const map = useMap();
  const theme = useTheme();
  const themeRef = useRef(theme);
  const [webgl] = useState(hasWebGL);
  const [gl, setGl] = useState<LibreMap | null>(null);
  const [styled, setStyled] = useState<LibreMap | null>(null);
  usePoiHighlights(map, places ? gl : null);
  useEffect(() => {
    if (!webgl) return;
    setWorkerUrl(new URL(WORKER, window.location.origin).href);
    const layer = L.maplibreGL({ style: STYLE, attributionControl: false });
    layer.getAttribution = () => ATTRIBUTION;
    layer.addTo(map);
    const gl = layer.getMaplibreMap();
    const onStyle = () => {
      if (places) {
        addPlaces(gl);
        installPoiLayers(gl);
        setGl(gl);
      }
      restyle(gl, themeRef.current);
      restylePlaces(gl, themeRef.current);
      restylePoiLayers(gl, themeRef.current);
      setStyled(gl);
    };
    gl.on("style.load", onStyle);
    if (!places) {
      return () => {
        gl.off("style.load", onStyle);
        setStyled(null);
        layer.remove();
      };
    }
    // Leaflet sits over the MapLibre canvas, so taps come in through Leaflet. A tap on one of our own
    // lines or icons is theirs, not the place's under it.
    const ours = (e: L.LeafletMouseEvent) => (e.originalEvent.target as Element | null)?.closest?.(".leaflet-interactive, .leaflet-marker-icon");
    const onClick = (e: L.LeafletMouseEvent) => {
      if (ours(e)) return;
      // A tap on nothing closes the open card.
      pickPlace(placeAt(gl, e.latlng.lat, e.latlng.lng));
    };
    let frame = 0;
    const onMove = (e: L.LeafletMouseEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        map.getContainer().style.cursor = !ours(e) && placeAt(gl, e.latlng.lat, e.latlng.lng) ? "pointer" : "";
      });
    };
    map.on("click", onClick);
    map.on("mousemove", onMove);
    return () => {
      cancelAnimationFrame(frame);
      map.off("click", onClick);
      map.off("mousemove", onMove);
      gl.off("style.load", onStyle);
      setGl(null);
      setStyled(null);
      layer.remove();
    };
  }, [map, webgl, places]);
  // The theme changed: repaint the loaded map in place (no reload).
  useEffect(() => {
    themeRef.current = theme;
    if (!styled) return;
    restyle(styled, theme);
    restylePlaces(styled, theme);
    restylePoiLayers(styled, theme);
  }, [theme, styled]);
  // The picked place's card is drawn by PlacesLayer (one card for every kind of place).
  if (webgl) return null;
  return <TileLayer key={theme} attribution={RASTER_ATTRIBUTION} url={rasterUrl(theme)} />;
}
