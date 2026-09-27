"use client";

/**
 * Nearby highlights on the street map: gas stations, EV chargers and parking as clear round
 * icons, from zoom 13 (the street map's own dots only start at 15). They're read from the zoom-14
 * tiles around the view (see pois.ts) into a GeoJSON source drawn by MapLibre, so hundreds of
 * parking lots stay cheap. Turned on and off from the map's layers menu.
 */

import type L from "leaflet";
import type { GeoJSONSource, Map as LibreMap, SymbolLayerSpecification } from "maplibre-gl";
import { useEffect } from "react";

import { POI, POI_KINDS, loadTiles, tilesIn, type Poi } from "./pois";
import { getPoiLayers, setMapZoom, setPoiStatus, subscribePoiLayers, type PoiKind } from "./store";

const SOURCE = "bs-pois";
/** Leaflet zoom from which the highlights show (about 70 tiles on a laptop screen). */
export const MIN_ZOOM = 13;
const MAX_TILES = 120;
const BG = "#171A21";
const INK = "#0E1015";
export const HIGHLIGHT_LAYERS = ["bs-poi-parking", "bs-poi-main"];

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

/** A colored disc with a dark glyph, drawn once per kind (2x for sharp screens). */
function iconImage(kind: PoiKind): ImageData {
  const size = 26;
  const ratio = 2;
  const c = document.createElement("canvas");
  c.width = c.height = size * ratio;
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  g.scale(ratio, ratio);
  g.beginPath();
  g.arc(size / 2, size / 2, size / 2 - 1.5, 0, Math.PI * 2);
  g.fillStyle = POI[kind].color;
  g.fill();
  g.lineWidth = 2;
  g.strokeStyle = INK;
  g.stroke();
  g.save();
  g.translate(size / 2 - 7.5, size / 2 - 7.5);
  g.scale(15 / 24, 15 / 24);
  g.strokeStyle = INK;
  g.lineWidth = 2.8;
  g.lineCap = "round";
  g.lineJoin = "round";
  g.stroke(new Path2D(POI[kind].icon));
  g.restore();
  return g.getImageData(0, 0, size * ratio, size * ratio);
}

export function installPoiLayers(m: LibreMap) {
  if (m.getSource(SOURCE)) return;
  for (const k of POI_KINDS) if (!m.hasImage(`bs-poi-${k}`)) m.addImage(`bs-poi-${k}`, iconImage(k), { pixelRatio: 2 });
  m.addSource(SOURCE, { type: "geojson", data: EMPTY });
  // Names from street level (MapLibre zoom 14 = Leaflet 15); unnamed parking lots stay just an icon.
  const label: SymbolLayerSpecification["layout"] = {
    "text-field": ["step", ["zoom"], "", 14, ["case", ["get", "named"], ["get", "name"], ""]],
    "text-font": ["Noto Sans Regular"],
    "text-size": 11.5,
    "text-anchor": "left",
    "text-offset": [1, 0],
    "text-max-width": 8,
    "text-optional": true,
  };
  const paint: SymbolLayerSpecification["paint"] = { "text-halo-color": BG, "text-halo-width": 1.4 };
  m.addLayer({
    id: "bs-poi-parking",
    type: "symbol",
    source: SOURCE,
    filter: ["==", ["get", "kind"], "parking"],
    layout: { ...label, "icon-image": "bs-poi-parking", "icon-size": 0.85, "icon-padding": 1 },
    paint: { ...paint, "text-color": POI.parking.color },
  });
  m.addLayer({
    id: "bs-poi-main",
    type: "symbol",
    source: SOURCE,
    filter: ["!=", ["get", "kind"], "parking"],
    layout: { ...label, "icon-image": ["concat", "bs-poi-", ["get", "kind"]], "icon-allow-overlap": true },
    paint: { ...paint, "text-color": ["match", ["get", "kind"], "ev", POI.ev.color, POI.fuel.color] },
  });
}

function geojson(pois: Poi[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: pois.map((p) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.lng, p.lat] },
      properties: { kind: p.kind, name: p.name, named: p.name !== POI[p.kind].one, osm: p.osm ?? "", sub: p.sub },
    })),
  };
}

/** Keeps the highlights in step with the layer toggles and the view. */
export function usePoiHighlights(map: L.Map, gl: LibreMap | null) {
  useEffect(() => {
    if (!gl) return;
    let gen = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const source = () => gl.getSource(SOURCE) as GeoJSONSource | undefined;
    const update = () => {
      clearTimeout(timer);
      setMapZoom(map.getZoom());
      timer = setTimeout(async () => {
        const g = ++gen;
        const on = POI_KINDS.filter((k) => getPoiLayers()[k]);
        if (!on.length || map.getZoom() < MIN_ZOOM) {
          setPoiStatus(on.length ? "zoom" : "ok");
          return source()?.setData(EMPTY);
        }
        const b = map.getBounds().pad(0.05);
        const list = tilesIn(b.getSouth(), b.getWest(), b.getNorth(), b.getEast());
        if (list.length > MAX_TILES) {
          setPoiStatus("zoom");
          return source()?.setData(EMPTY);
        }
        const got = await loadTiles(list);
        if (g !== gen) return;
        setPoiStatus(got.failed === got.total ? "failed" : "ok");
        source()?.setData(geojson(got.pois.filter((p) => on.includes(p.kind))));
      }, 200);
    };
    map.on("moveend", update);
    const unsub = subscribePoiLayers(update);
    update();
    return () => {
      gen++; // a load still on its way doesn't touch a map that's gone
      clearTimeout(timer);
      map.off("moveend", update);
      unsub();
    };
  }, [map, gl]);
}
