"use client";

/**
 * Small shared stores for places, readable from any component (the map, its popup, the screens)
 * without going through AppContext:
 *  - saved places: Home, Work and favorites, kept in this browser (localStorage; no accounts)
 *  - which nearby layers are on (gas, EV chargers, parking)
 *  - the place whose card is open on the map, and the nearby list's markers
 * Storage can be missing or full (private windows): every read and write is wrapped, and the
 * app works the same without it (nothing is remembered).
 */

import { useSyncExternalStore } from "react";

import type { PlaceRef } from "@/lib/types";

function createStore<T>(initial: T, persist?: { key: string; clean: (raw: unknown) => T }) {
  let state = initial;
  let loaded = !persist;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  const get = (): T => {
    if (!loaded && persist && typeof window !== "undefined") {
      loaded = true;
      try {
        const raw = window.localStorage.getItem(persist.key);
        if (raw) state = persist.clean(JSON.parse(raw));
      } catch {}
    }
    return state;
  };
  const set = (next: T) => {
    get();
    state = next;
    if (persist) {
      try {
        window.localStorage.setItem(persist.key, JSON.stringify(next));
      } catch {}
    }
    notify();
  };
  const subscribe = (l: () => void) => {
    listeners.add(l);
    // Another tab changed it: read it again.
    const onStorage = (e: StorageEvent) => {
      if (persist && e.key === persist.key) {
        loaded = false;
        get();
        l();
      }
    };
    if (persist) window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(l);
      if (persist) window.removeEventListener("storage", onStorage);
    };
  };
  const use = () => useSyncExternalStore(subscribe, get, () => initial);
  return { get, set, subscribe, use };
}

// ---- saved places ---------------------------------------------------------------------------------

export interface SavedPlace extends PlaceRef {
  key: string;
}

export interface Saved {
  home: SavedPlace | null;
  work: SavedPlace | null;
  favorites: SavedPlace[];
}

export type Slot = "home" | "work";

const NO_SAVED: Saved = { home: null, work: null, favorites: [] };
const MAX_FAVORITES = 20;

/** The same place, whichever way we came to it (search result, map dot, saved). */
export function placeKey(p: PlaceRef): string {
  if (p.osm) return p.osm;
  if (p.placeId) return `place:${p.placeId}`;
  return `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
}

function cleanPlace(v: unknown): SavedPlace | null {
  if (!v || typeof v !== "object") return null;
  const p = v as Record<string, unknown>;
  if (typeof p.name !== "string" || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return null;
  const str = (x: unknown) => (typeof x === "string" && x ? x : undefined);
  const place: PlaceRef = {
    name: p.name.slice(0, 120),
    lat: p.lat as number,
    lng: p.lng as number,
    osm: str(p.osm) && /^[NWR]\d+$/.test(p.osm as string) ? (p.osm as string) : undefined,
    placeId: str(p.placeId),
    kind: str(p.kind),
    address: str(p.address),
    color: str(p.color) && /^(#[0-9a-f]{3,8}|var\(--c-[a-z-]+\))$/i.test(p.color as string) ? (p.color as string) : undefined,
  };
  return { ...place, key: placeKey(place) };
}

function cleanSaved(raw: unknown): Saved {
  if (!raw || typeof raw !== "object") return NO_SAVED;
  const r = raw as Record<string, unknown>;
  const favs = Array.isArray(r.favorites) ? r.favorites.map(cleanPlace).filter((p): p is SavedPlace => !!p) : [];
  return { home: cleanPlace(r.home), work: cleanPlace(r.work), favorites: favs.slice(0, MAX_FAVORITES) };
}

const savedStore = createStore<Saved>(NO_SAVED, { key: "blindspot.saved", clean: cleanSaved });

function toSaved(p: PlaceRef): SavedPlace {
  const { name, lat, lng, osm, placeId, kind, address, color } = p;
  return { name, lat, lng, osm: osm ?? undefined, placeId, kind: kind ?? undefined, address: address ?? undefined, color, key: placeKey(p) };
}

export const useSaved = savedStore.use;

export function setSlot(slot: Slot, p: PlaceRef | null) {
  savedStore.set({ ...savedStore.get(), [slot]: p ? toSaved(p) : null });
}

export function isFavorite(s: Saved, p: PlaceRef): boolean {
  const k = placeKey(p);
  return s.favorites.some((f) => f.key === k);
}

export function toggleFavorite(p: PlaceRef) {
  const s = savedStore.get();
  const k = placeKey(p);
  const favorites = s.favorites.some((f) => f.key === k)
    ? s.favorites.filter((f) => f.key !== k)
    : [toSaved(p), ...s.favorites].slice(0, MAX_FAVORITES);
  savedStore.set({ ...s, favorites });
}

export function removeFavorite(key: string) {
  const s = savedStore.get();
  savedStore.set({ ...s, favorites: s.favorites.filter((f) => f.key !== key) });
}

/** "home" / "work" when this place is saved as one. */
export function slotOf(s: Saved, p: PlaceRef): Slot | null {
  const k = placeKey(p);
  if (s.home?.key === k) return "home";
  if (s.work?.key === k) return "work";
  return null;
}

// ---- nearby layers (gas, EV chargers, parking) -----------------------------------------------------

export type PoiKind = "fuel" | "ev" | "parking";
export type PoiLayers = Record<PoiKind, boolean>;

const NO_POIS: PoiLayers = { fuel: false, ev: false, parking: false };

const poiLayerStore = createStore<PoiLayers>(NO_POIS, {
  key: "blindspot.poiLayers",
  clean: (raw) => {
    const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    return { fuel: r.fuel === true, ev: r.ev === true, parking: r.parking === true };
  },
});

export const usePoiLayers = poiLayerStore.use;
export const getPoiLayers = poiLayerStore.get;
export const subscribePoiLayers = poiLayerStore.subscribe;

export function setPoiLayer(kind: PoiKind, on: boolean) {
  poiLayerStore.set({ ...poiLayerStore.get(), [kind]: on });
}

// ---- the map's open place card, and the nearby list's markers ------------------------------------------

const pickedStore = createStore<PlaceRef | null>(null);
export const usePicked = pickedStore.use;
/** Open (or close, with null) the place card on the map. */
export const pickPlace = pickedStore.set;

export interface NearbyMarker extends PlaceRef {
  key: string;
  poi: PoiKind;
}

const nearbyStore = createStore<{ items: NearbyMarker[]; selected: string | null }>({ items: [], selected: null });
export const useNearbyMarkers = nearbyStore.use;
export const setNearbyMarkers = nearbyStore.set;

/** The main map's zoom (kept by the basemap), for "zoom in to see them". */
const zoomStore = createStore<number>(11);
export const useMapZoom = zoomStore.use;
export const setMapZoom = zoomStore.set;

/** How the nearby highlights on the map are doing: shown, too far out to show, or failed to load. */
export type PoiStatus = "ok" | "zoom" | "failed";
const poiStatusStore = createStore<PoiStatus>("ok");
export const usePoiStatus = poiStatusStore.use;
export const setPoiStatus = poiStatusStore.set;
