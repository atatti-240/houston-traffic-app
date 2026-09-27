"use client";

/**
 * Gas stations, EV chargers and parking straight from the street map's own data: the OpenMapTiles
 * `poi` layer of OpenFreeMap's vector tiles (OpenStreetMap, free, no key). Those only exist in the
 * zoom-14 tiles, so we fetch and read the zoom-14 tiles we need ourselves (the browser caches them,
 * and they're the same files the map loads when you zoom in). Used for the nearby highlights on the
 * map and the "Gas near me" / "Gas along my route" lists.
 *
 * In the tiles, gas is class "fuel", EV chargers are class "fuel" with subclass "charging_station",
 * and parking is class "parking". A feature's id is its OpenStreetMap id × 10 + 1 (node), 2 (way) or
 * 3 (relation), which gives the place card its details.
 */

import { VectorTile, type VectorTileFeature } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";

import type { LatLngTuple } from "@/lib/types";

import type { PoiKind } from "./store";

const TILEJSON = "https://tiles.openfreemap.org/planet";
const Z = 14;
const TIMEOUT_MS = 10000;
const PARALLEL = 6;

export const POI: Record<PoiKind, { label: string; one: string; color: string; icon: string }> = {
  fuel: {
    label: "Gas",
    one: "Gas station",
    color: "#F29D38",
    // pump + hose
    icon: "M5 20V5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v15M4 20h11M5 10h9M14 8l3 2.5V16a1.5 1.5 0 0 0 3 0V9l-2.5-3",
  },
  ev: { label: "EV charging", one: "EV charger", color: "#34C9A0", icon: "M13 3L6 13.5h5L10 21l7-10.5h-5z" },
  parking: { label: "Parking", one: "Parking", color: "#5B8DEF", icon: "M8 20V4h5a4.5 4.5 0 0 1 0 9H8" },
};
export const POI_KINDS: PoiKind[] = ["fuel", "ev", "parking"];

export interface Poi {
  /** OpenStreetMap id ("W123"), or the tile feature id when it isn't one */
  key: string;
  osm: string | null;
  kind: PoiKind;
  name: string;
  /** "Gas station", "EV charger", "Parking garage" */
  sub: string;
  lat: number;
  lng: number;
}

// ---- tile math --------------------------------------------------------------------------------

export function tileOf(lat: number, lng: number, z = Z): { x: number; y: number } {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return {
    x: Math.floor(((lng + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n),
  };
}

function toLatLng(x: number, y: number, z = Z): LatLngTuple {
  const n = 2 ** z;
  const lng = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return [lat, lng];
}

export function metersBetween(a: LatLngTuple, b: LatLngTuple): number {
  const k = Math.PI / 180;
  const dLat = (b[0] - a[0]) * k;
  const dLng = (b[1] - a[1]) * k;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * k) * Math.cos(b[0] * k) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

/** "0.4 mi", "12 mi" */
export function miles(m: number): string {
  const mi = m / 1609.344;
  return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
}

// ---- loading tiles -----------------------------------------------------------------------------

let template: Promise<string> | null = null;

async function fetchTimeout(url: string): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`${res.status}`);
    return res;
  } finally {
    clearTimeout(t);
  }
}

function tileUrl(): Promise<string> {
  template ??= fetchTimeout(TILEJSON)
    .then((r) => r.json())
    .then((j: { tiles?: string[] }) => {
      if (!j.tiles?.[0]) throw new Error("no tiles");
      return j.tiles[0];
    })
    .catch((e) => {
      template = null; // try again next time
      throw e;
    });
  return template;
}

/** A tile feature's id -> its OpenStreetMap id ("W123"), or null. */
export function osmRef(id: number | undefined): string | null {
  if (id === undefined || !Number.isFinite(id) || id <= 0) return null;
  const type = { 1: "N", 2: "W", 3: "R" }[id % 10];
  const osm = Math.floor(id / 10);
  return type && osm > 0 ? `${type}${osm}` : null;
}

function kindOf(cls: unknown, sub: unknown): PoiKind | null {
  if (cls === "fuel") return sub === "charging_station" ? "ev" : "fuel";
  if (cls === "parking") return "parking";
  return null;
}

function readTile(buf: ArrayBuffer, x: number, y: number): Poi[] {
  const layer = new VectorTile(new PbfReader(new Uint8Array(buf))).layers.poi;
  if (!layer) return [];
  const out: Poi[] = [];
  for (let i = 0; i < layer.length; i++) {
    const f: VectorTileFeature = layer.feature(i);
    const p = f.properties;
    const kind = kindOf(p.class, p.subclass);
    if (!kind || f.type !== 1) continue;
    const pt = f.loadGeometry()[0]?.[0];
    if (!pt) continue;
    const [lat, lng] = toLatLng(x + pt.x / f.extent, y + pt.y / f.extent);
    const name = String(p.name_en || p.name || "").trim();
    const osm = osmRef(f.id);
    const sub = String(p.subclass ?? "");
    out.push({
      key: osm ?? `t${f.id ?? `${x}-${y}-${i}`}`,
      osm,
      kind,
      name: name || POI[kind].one,
      sub: kind === "parking" && /garage|multi/.test(sub) ? "Parking garage" : POI[kind].one,
      lat,
      lng,
    });
  }
  return out;
}

const tiles = new Map<string, Promise<Poi[]>>();

function loadTile(x: number, y: number): Promise<Poi[]> {
  const k = `${x}/${y}`;
  let p = tiles.get(k);
  if (!p) {
    p = tileUrl()
      .then((t) => fetchTimeout(t.replace("{z}", String(Z)).replace("{x}", String(x)).replace("{y}", String(y))))
      .then((r) => r.arrayBuffer())
      .then((buf) => readTile(buf, x, y));
    p.catch(() => tiles.delete(k)); // a failed tile is asked again next time
    tiles.set(k, p);
  }
  return p;
}

export interface Loaded {
  pois: Poi[];
  /** Some tiles didn't load (the map data server is down or slow) */
  failed: number;
  total: number;
}

/** Everything in these tiles (deduped: a place near a tile edge is in both). */
export async function loadTiles(list: { x: number; y: number }[]): Promise<Loaded> {
  const byKey = new Map<string, Poi>();
  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const t = list[next++];
      try {
        for (const p of await loadTile(t.x, t.y)) byKey.set(p.key, p);
      } catch {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, list.length) }, worker));
  return { pois: [...byKey.values()], failed, total: list.length };
}

/** The zoom-14 tiles covering a box (south, west, north, east). */
export function tilesIn(s: number, w: number, n: number, e: number): { x: number; y: number }[] {
  const a = tileOf(n, w);
  const b = tileOf(s, e);
  const out = [];
  for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) out.push({ x, y });
  return out;
}

// ---- nearby lists -------------------------------------------------------------------------------

export interface NearbyItem extends Poi {
  /** Straight-line meters from you (near) or off the route (along) */
  off: number;
  /** Meters along the route to the closest point to it (along only) */
  along?: number;
}

export interface NearbyResult {
  items: NearbyItem[];
  failed: boolean;
}

/** The closest few of a kind around a point: the tiles within ~2 km, then ~4 km if that's thin. */
export async function findNear(kind: PoiKind, lat: number, lng: number, want = 6): Promise<NearbyResult> {
  const c = tileOf(lat, lng);
  let items: NearbyItem[] = [];
  let failed = false;
  for (const r of [1, 2]) {
    const list = [];
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) list.push({ x: c.x + dx, y: c.y + dy });
    const got = await loadTiles(list);
    failed = got.failed === got.total;
    items = got.pois
      .filter((p) => p.kind === kind)
      .map((p) => ({ ...p, off: metersBetween([lat, lng], [p.lat, p.lng]) }))
      .sort((a, b) => a.off - b.off);
    if (items.length >= want || failed) break;
  }
  return { items: items.slice(0, want), failed: failed && !items.length };
}

/** Where a point is relative to a route: meters off it and meters along it. */
export function onRoute(route: LatLngTuple[], p: LatLngTuple): { off: number; along: number } {
  const k = Math.cos((p[0] * Math.PI) / 180) * 111320;
  const xy = (q: LatLngTuple) => [q[1] * k, q[0] * 111320] as const;
  const [px, py] = xy(p);
  let best = { off: Infinity, along: 0 };
  let walked = 0;
  for (let i = 1; i < route.length; i++) {
    const [ax, ay] = xy(route[i - 1]);
    const [bx, by] = xy(route[i]);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const off = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    const len = Math.sqrt(len2);
    if (off < best.off) best = { off, along: walked + t * len };
    walked += len;
  }
  return best;
}

/** Up to `want` of a kind within ~half a mile of a route, in the order you pass them: the closest
 * to the road in each stretch of the route, so they're spread along it (not all at one exit). */
export async function findAlong(kind: PoiKind, route: LatLngTuple[], want = 6, maxOff = 800): Promise<NearbyResult> {
  // The tiles the route passes through, plus a neighbour when it runs close to a tile edge.
  const seen = new Map<string, { x: number; y: number }>();
  const add = (lat: number, lng: number) => {
    const t = tileOf(lat, lng);
    seen.set(`${t.x}/${t.y}`, t);
  };
  const dLat = maxOff / 111320;
  for (let i = 0; i < route.length; i++) {
    const a = route[i];
    const b = route[Math.min(i + 1, route.length - 1)];
    const steps = Math.max(1, Math.ceil(metersBetween(a, b) / 300));
    for (let s = 0; s < steps; s++) {
      const lat = a[0] + ((b[0] - a[0]) * s) / steps;
      const lng = a[1] + ((b[1] - a[1]) * s) / steps;
      const dLng = dLat / Math.cos((lat * Math.PI) / 180);
      for (const [oy, ox] of [[0, 0], [dLat, 0], [-dLat, 0], [0, dLng], [0, -dLng]]) add(lat + oy, lng + ox);
    }
  }
  const list = [...seen.values()].slice(0, 160);
  const got = await loadTiles(list);
  const near = got.pois
    .filter((p) => p.kind === kind)
    .map((p) => ({ ...p, ...onRoute(route, [p.lat, p.lng]) }))
    .filter((p) => p.off <= maxOff)
    .sort((a, b) => a.off - b.off);
  const total = Math.max(1, route.reduce((s, p, i) => (i ? s + metersBetween(route[i - 1], p) : 0), 0));
  const picked = new Set<(typeof near)[number]>();
  for (let i = 0; i < want; i++) {
    const best = near.find((p) => p.along >= (total * i) / want && p.along <= (total * (i + 1)) / want);
    if (best) picked.add(best);
  }
  for (const p of near) if (picked.size < want) picked.add(p);
  return { items: [...picked].sort((a, b) => a.along - b.along), failed: got.failed === got.total };
}
