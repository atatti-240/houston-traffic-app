/**
 * The street map's look: OpenFreeMap's vector style (OpenStreetMap data, no key), recolored like
 * Google Maps in light and dark. `restyle()` repaints a loaded map in place, so switching the theme
 * never reloads the map. MapLibre needs real color values (not CSS variables), so the palettes live
 * here; keep them close to the --c-* colors in app/globals.css.
 */

import type { ExpressionSpecification, Map as LibreMap } from "maplibre-gl";

import type { Theme } from "@/lib/themeMode";

export const STYLE = "https://tiles.openfreemap.org/styles/dark";
// Copied here from node_modules on install (scripts/copy-maplibre-worker.mjs): the bundler doesn't.
export const WORKER = "/maplibre/maplibre-gl-worker.mjs";
export const ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>';

/** Raster tiles for browsers without WebGL. */
export function rasterUrl(theme: Theme): string {
  return `https://{s}.basemaps.cartocdn.com/${theme === "dark" ? "dark_all" : "light_all"}/{z}/{x}/{y}{r}.png`;
}
export const RASTER_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

export function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

export interface Palette {
  land: string;
  water: string;
  waterLabel: string;
  park: string;
  building: string;
  buildingLine: string;
  path: string;
  road: string;
  roadCasing: string;
  major: string;
  majorCasing: string;
  motorway: string;
  motorwayCasing: string;
  /** thin roads at low zoom */
  majorFar: string;
  motorwayFar: string;
  rail: string;
  railDash: string;
  runway: string;
  airport: string;
  label: string;
  halo: string;
}

export const BASEMAP: Record<Theme, Palette> = {
  light: {
    land: "#f8f9fa",
    water: "#aadaff",
    waterLabel: "#3b77b8",
    park: "#ceead6",
    building: "#e8eaed",
    buildingLine: "#dadce0",
    path: "#c4c7c5",
    road: "#ffffff",
    roadCasing: "#dadce0",
    major: "#ffffff",
    majorCasing: "#d2d5d9",
    // Google's highway yellow, a little paler: with traffic on the map, the traffic colors should win.
    motorway: "#fde9a9",
    motorwayCasing: "#f1cd76",
    majorFar: "#dadce0",
    motorwayFar: "#f6d98f",
    rail: "#bdc1c6",
    railDash: "#f8f9fa",
    runway: "#e3e5e8",
    airport: "#eceef1",
    label: "#5f6368",
    halo: "#ffffff",
  },
  dark: {
    land: "#242424",
    water: "#2b3a44",
    waterLabel: "#8fa4b4",
    park: "#1f2b22",
    building: "#2a2a2a",
    buildingLine: "#313131",
    path: "#383838",
    road: "#3c3c3c",
    roadCasing: "#242424",
    major: "#4d4d4d",
    majorCasing: "#242424",
    motorway: "#5f5f5f",
    motorwayCasing: "#242424",
    majorFar: "#3c3c3c",
    motorwayFar: "#4d4d4d",
    rail: "#4d4d4d",
    railDash: "#242424",
    runway: "#3a3a3a",
    airport: "#2a2a2a",
    label: "#9aa0a6",
    halo: "#1f1f1f",
  },
};

/** Place kinds on the street map, colored like Google Maps' categories (the same as --c-poi-* in globals.css). */
export type PlaceKind = "food" | "shop" | "health" | "park" | "fun" | "hotel" | "car";

export const PLACE_KINDS: { kind: PlaceKind; label: string; classes: string[] }[] = [
  { kind: "food", label: "Food & drink", classes: ["restaurant", "fast_food", "cafe", "bar", "beer", "ice_cream", "bakery"] },
  {
    kind: "shop",
    label: "Shopping",
    classes: ["shop", "grocery", "clothing_store", "jewelry", "furniture", "hardware", "mobile_phone", "book", "florist", "alcohol_shop", "laundry", "music"],
  },
  { kind: "health", label: "Health", classes: ["hospital", "doctors", "pharmacy", "dentist", "veterinary"] },
  { kind: "park", label: "Outdoors", classes: ["park", "playground", "garden", "campsite", "pitch", "swimming", "golf"] },
  { kind: "fun", label: "Things to do", classes: ["attraction", "museum", "theatre", "cinema", "zoo", "stadium", "art_gallery", "monument", "castle", "entertainment"] },
  { kind: "hotel", label: "Hotel", classes: ["lodging"] },
  { kind: "car", label: "Car", classes: ["fuel", "car", "charging_station"] },
];

/** Dot and label colors per theme: a touch darker on the light map, lighter on the dark one, so names stay readable. */
export const PLACE_COLOR: Record<Theme, Record<PlaceKind | "other", string>> = {
  light: { food: "#e8710a", shop: "#1a73e8", health: "#d93025", park: "#188038", fun: "#129eaf", hotel: "#9334e6", car: "#5f6368", other: "#70757a" },
  dark: { food: "#fcad70", shop: "#8ab4f8", health: "#f28b82", park: "#81c995", fun: "#78d9ec", hotel: "#d7aefb", car: "#9aa0a6", other: "#9aa0a6" },
};

/** The CSS color of a place kind (for cards and lists; follows the theme). */
export function placeCss(kind: PlaceKind | "other"): string {
  return `var(--c-poi-${kind})`;
}

export function placeKindOf(cls: string): PlaceKind | "other" {
  return PLACE_KINDS.find((k) => k.classes.includes(cls))?.kind ?? "other";
}

/** MapLibre expression: a place's color by its class. */
export function placeColor(theme: Theme): ExpressionSpecification {
  const c = PLACE_COLOR[theme];
  return ["match", ["get", "class"], ...PLACE_KINDS.flatMap((k) => [k.classes, c[k.kind]]), c.other] as unknown as ExpressionSpecification;
}

const MINOR_CASING = "bs-minor-casing";

/** A casing under the small streets (the style has none), so white streets show on the light map. */
function addMinorCasing(m: LibreMap) {
  if (m.getLayer(MINOR_CASING) || !m.getLayer("highway_minor")) return;
  const minor = m.getStyle().layers?.find((l) => l.id === "highway_minor");
  if (!minor || minor.type !== "line") return;
  m.addLayer(
    {
      id: MINOR_CASING,
      type: "line",
      source: minor.source,
      "source-layer": minor["source-layer"],
      minzoom: 12,
      filter: minor.filter,
      layout: minor.layout,
      paint: { "line-width": ["interpolate", ["exponential", 1.55], ["zoom"], 13, 3, 20, 23] },
    },
    "highway_minor",
  );
}

type Paint = Parameters<LibreMap["setPaintProperty"]>[1];

/** Repaint the street map for a theme (call on style.load and whenever the theme changes). */
export function restyle(m: LibreMap, theme: Theme) {
  const p = BASEMAP[theme];
  const set = (layer: string, prop: Paint, value: Parameters<LibreMap["setPaintProperty"]>[2]) => {
    if (m.getLayer(layer)) m.setPaintProperty(layer, prop, value);
  };
  addMinorCasing(m);
  set("background", "background-color", p.land);
  set("water", "fill-color", p.water);
  set("waterway", "line-color", p.water);
  set("landuse_park", "fill-color", p.park);
  set("landcover_wood", "fill-color", p.park);
  set("landcover_wood", "fill-pattern", undefined);
  set("landcover_wood", "fill-opacity", 0.8);
  set("landuse_residential", "fill-opacity", 0);
  for (const id of ["landcover_ice_shelf", "landcover_glacier"]) set(id, "fill-color", p.land);
  set("building", "fill-color", p.building);
  set("building", "fill-outline-color", p.buildingLine);
  set("highway_path", "line-color", p.path);
  set("highway_minor", "line-color", p.road);
  set("highway_minor", "line-opacity", 1);
  set(MINOR_CASING, "line-color", p.roadCasing);
  for (const id of ["road_area_pier"]) set(id, "fill-color", p.road);
  set("road_pier", "line-color", p.road);
  set("highway_major_casing", "line-color", p.majorCasing);
  set("highway_major_inner", "line-color", p.major);
  set("highway_major_subtle", "line-color", p.majorFar);
  set("highway_motorway_casing", "line-color", p.motorwayCasing);
  set("highway_motorway_inner", "line-color", p.motorway);
  set("highway_motorway_subtle", "line-color", p.motorwayFar);
  for (const id of ["railway", "railway_transit", "railway_minor"]) set(id, "line-color", p.rail);
  for (const id of ["railway_dashline", "railway_transit_dashline", "railway_minor_dashline"]) set(id, "line-color", p.railDash);
  set("aeroway-area", "fill-color", p.airport);
  for (const id of ["aeroway-runway", "aeroway-taxiway"]) set(id, "line-color", p.runway);
  set("aeroway-runway-casing", "line-color", p.airport);
  for (const id of ["highway_name_other", "highway_name_motorway"]) {
    set(id, "text-color", p.label);
    set(id, "text-halo-color", p.halo);
    set(id, "text-halo-width", 1.2);
  }
  set("water_name", "text-color", p.waterLabel);
  set("water_name", "text-halo-color", p.water);
  // Neighborhood names come from our own place labels; the rail lines stay (trains matter here).
  for (const layer of m.getStyle().layers ?? []) {
    if ((layer.id.startsWith("place_") || layer.id.startsWith("boundary_")) && m.getLayoutProperty(layer.id, "visibility") !== "none")
      m.setLayoutProperty(layer.id, "visibility", "none");
  }
}
