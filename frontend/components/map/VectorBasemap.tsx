"use client";

/**
 * Street map under the traffic: OpenFreeMap's free dark vector style (OpenStreetMap data, no
 * key), drawn by MapLibre inside the Leaflet map so every overlay keeps working. Recolored to
 * the design's blue-grey with quiet roads, so our traffic lines stand out. Falls back to raster
 * tiles when the browser has no WebGL.
 */

import "maplibre-gl/dist/maplibre-gl.css";
import "@maplibre/maplibre-gl-leaflet";
import L from "leaflet";
import { setWorkerUrl, type ExpressionSpecification, type Map as LibreMap } from "maplibre-gl";
import { useEffect, useState } from "react";
import { Popup, TileLayer, useMap } from "react-leaflet";
import { useApp } from "@/components/app/AppContext";
import { drive } from "@/components/drive/store";
import { C } from "@/lib/theme";

const STYLE = "https://tiles.openfreemap.org/styles/dark";
// Copied here from node_modules on install (scripts/copy-maplibre-worker.mjs): the bundler doesn't.
const WORKER = "/maplibre/maplibre-gl-worker.mjs";
const ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>';

// The design's palette (see globals.css).
const BG = "#171A21";
const WATER = "#10131A";
const PARK = "#1A2024";
const BUILDING = "#1D2129";
const ROAD = "#2A2F3A";
const ROAD_MAJOR = "#333948";
const LABEL = "#7C8494";

// Places (shops, food, parks...): a dot colored by kind with its name, like Google Maps. Bigger places
// (lower OpenMapTiles rank) show up first as you zoom in.
const KINDS: { color: string; label: string; classes: string[] }[] = [
  { color: "#E8894A", label: "Food & drink", classes: ["restaurant", "fast_food", "cafe", "bar", "beer", "ice_cream", "bakery"] },
  { color: "#6E9BF0", label: "Shopping", classes: ["shop", "grocery", "clothing_store", "jewelry", "furniture", "hardware", "mobile_phone", "book", "florist", "alcohol_shop", "laundry", "music"] },
  { color: "#E0707A", label: "Health", classes: ["hospital", "doctors", "pharmacy", "dentist", "veterinary"] },
  { color: "#5DB57A", label: "Outdoors", classes: ["park", "playground", "garden", "campsite", "pitch", "swimming", "golf"] },
  { color: "#45B7C6", label: "Things to do", classes: ["attraction", "museum", "theatre", "cinema", "zoo", "stadium", "art_gallery", "monument", "castle", "entertainment"] },
  { color: "#A889E8", label: "Hotel", classes: ["lodging"] },
  { color: "#8FA1BF", label: "Car", classes: ["fuel", "car", "charging_station"] },
];
const OTHER = "#9AA3B2";
const HIDDEN = ["bus", "parking", "entrance", "bicycle", "bicycle_rental", "toilets", "drinking_water", "information", "atm"];
const POI_BANDS: [string, number, number, number][] = [
  // [id suffix, from rank, to rank (exclusive), minzoom]
  ["1", 1, 4, 14],
  ["2", 4, 10, 15],
  ["3", 10, 20, 16],
  ["4", 20, 1000, 17],
];
const POI_LAYERS = POI_BANDS.map(([id]) => `poi-dot-${id}`);

function kindOf(cls: string) {
  return KINDS.find((k) => k.classes.includes(cls));
}

function poiColor(): ExpressionSpecification {
  return ["match", ["get", "class"], ...KINDS.flatMap((k) => [k.classes, k.color]), OTHER] as unknown as ExpressionSpecification;
}

function addPlaces(m: LibreMap) {
  if (!m.getSource("openmaptiles") || m.getLayer(POI_LAYERS[0])) return;
  const color = poiColor();
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
    m.addLayer({
      ...base,
      id: `poi-dot-${id}`,
      type: "circle",
      paint: { "circle-color": color, "circle-radius": 4, "circle-stroke-color": BG, "circle-stroke-width": 1.5 },
    });
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
      paint: { "text-color": color, "text-halo-color": BG, "text-halo-width": 1.4 },
    });
  }
}

type Place = { lat: number; lng: number; name: string; kind: string; color: string };

function placeAt(m: LibreMap, lat: number, lng: number): Place | null {
  const p = m.project([lng, lat]);
  const hits = m.queryRenderedFeatures(
    [
      [p.x - 10, p.y - 10],
      [p.x + 10, p.y + 10],
    ],
    { layers: POI_LAYERS.filter((id) => m.getLayer(id)) },
  );
  const f = hits[0];
  if (!f || f.geometry.type !== "Point") return null;
  const [plng, plat] = f.geometry.coordinates;
  const props = f.properties as { name?: string; name_en?: string; class?: string; subclass?: string };
  const kind = kindOf(props.class ?? "");
  const sub = (props.subclass || props.class || "place").replace(/_/g, " ");
  return {
    lat: plat,
    lng: plng,
    name: props.name_en || props.name || "Place",
    kind: sub.charAt(0).toUpperCase() + sub.slice(1),
    color: kind?.color ?? OTHER,
  };
}

function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

function restyle(m: LibreMap) {
  const set = (layer: string, prop: Parameters<LibreMap["setPaintProperty"]>[1], value: string | number) => {
    if (m.getLayer(layer)) m.setPaintProperty(layer, prop, value);
  };
  set("background", "background-color", BG);
  set("water", "fill-color", WATER);
  set("landuse_park", "fill-color", PARK);
  set("landcover_wood", "fill-color", PARK);
  set("landuse_residential", "fill-opacity", 0);
  set("building", "fill-color", BUILDING);
  for (const id of ["highway_minor", "highway_path"]) set(id, "line-color", ROAD);
  for (const id of ["highway_major_inner", "highway_major_subtle", "highway_motorway_inner", "highway_motorway_subtle"]) set(id, "line-color", ROAD_MAJOR);
  for (const id of ["highway_major_casing", "highway_motorway_casing", "aeroway-runway-casing"]) set(id, "line-color", BG);
  for (const id of ["aeroway-runway", "aeroway-taxiway"]) set(id, "line-color", ROAD);
  set("aeroway-area", "fill-color", BUILDING);
  for (const id of ["highway_name_other", "highway_name_motorway", "water_name"]) {
    set(id, "text-color", LABEL);
    set(id, "text-halo-color", BG);
  }
  // Neighborhood names come from our own place labels; the rail lines stay (trains matter here).
  for (const layer of m.getStyle().layers ?? []) {
    if (layer.id.startsWith("place_") || layer.id.startsWith("boundary_")) m.setLayoutProperty(layer.id, "visibility", "none");
  }
}

/** `places`: show shops and places (tap one for directions). Off for small static previews. */
export default function VectorBasemap({ places = false }: { places?: boolean }) {
  const map = useMap();
  const { go } = useApp();
  const [webgl] = useState(hasWebGL);
  const [picked, setPicked] = useState<Place | null>(null);
  useEffect(() => {
    if (!webgl) return;
    setWorkerUrl(new URL(WORKER, window.location.origin).href);
    const layer = L.maplibreGL({ style: STYLE, attributionControl: false });
    layer.getAttribution = () => ATTRIBUTION;
    layer.addTo(map);
    const gl = layer.getMaplibreMap();
    const onStyle = () => {
      restyle(gl);
      if (places) addPlaces(gl);
    };
    gl.on("style.load", onStyle);
    if (!places) {
      return () => {
        gl.off("style.load", onStyle);
        layer.remove();
      };
    }
    // Leaflet sits over the MapLibre canvas, so taps come in through Leaflet. A tap on one of our own
    // lines or icons is theirs, not the place's under it.
    const ours = (e: L.LeafletMouseEvent) => (e.originalEvent.target as Element | null)?.closest?.(".leaflet-interactive, .leaflet-marker-icon");
    const onClick = (e: L.LeafletMouseEvent) => {
      // Driving: a tap only moves the map
      if (ours(e) || drive.get().active) return;
      const p = placeAt(gl, e.latlng.lat, e.latlng.lng);
      if (p) setPicked(p);
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
      layer.remove();
    };
  }, [map, webgl, places]);
  if (webgl) {
    if (!picked) return null;
    return (
      <Popup
        position={[picked.lat, picked.lng]}
        closeButton={false}
        offset={[0, -4]}
        className="cause-popup"
        eventHandlers={{ remove: () => setPicked(null) }}
      >
        <div style={{ width: 220, display: "flex", flexDirection: "column", gap: 4, fontFamily: "var(--font-grotesk), system-ui, sans-serif" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ width: 9, height: 9, borderRadius: 5, background: picked.color }} />
            <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: C.muted }}>{picked.kind}</span>
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.25, color: C.ink }}>{picked.name}</div>
          <button
            type="button"
            onClick={() => {
              setPicked(null);
              go({ name: "trip", to: { lat: picked.lat, lng: picked.lng }, toName: picked.name });
            }}
            style={{
              marginTop: 6,
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
            Directions →
          </button>
        </div>
      </Popup>
    );
  }
  return (
    <TileLayer
      attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
      url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
    />
  );
}
