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
import { setWorkerUrl, type Map as LibreMap } from "maplibre-gl";
import { useEffect, useState } from "react";
import { TileLayer, useMap } from "react-leaflet";

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

export default function VectorBasemap() {
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
