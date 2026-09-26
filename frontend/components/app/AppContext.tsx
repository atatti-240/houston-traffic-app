"use client";

/**
 * App-wide state: data from the API (polled), navigation between screens, what the map shows,
 * and notifications. Screens read everything through `useApp()`.
 *
 * Screens:  where (start) -> trip       map -> cameras       causes -> why       alerts
 * Tabs (bottom nav): map | causes | alerts.  "where" and "trip" are full-screen flows (no nav).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { api } from "@/lib/api";
import { levelForScore, type Level } from "@/lib/theme";
import type {
  AppNotification,
  Camera,
  ClockState,
  LatLngTuple,
  LiveConditions,
  Location,
  Place,
  Segment,
  SlowdownList,
  TrafficAlert,
} from "@/lib/types";

// ---- navigation ------------------------------------------------------------------------------

export type Screen =
  | { name: "where" }
  | {
      name: "trip";
      to: Location;
      toName?: string;
      /** Defaults to where you are (`here`) */
      from?: Location;
      fromName?: string;
      /** "HH:MM" to plan an arrive-by trip; omitted = leave now */
      arriveBy?: string;
      /** Faster (0) .. Safer (1) */
      safety?: number;
    }
  | { name: "map" }
  | { name: "cameras"; area?: string; camId?: string }
  | { name: "causes" }
  | { name: "why"; id: string }
  | { name: "alerts" };

export type Tab = "map" | "causes" | "alerts";

export function tabOf(s: Screen): Tab | null {
  if (s.name === "map" || s.name === "cameras") return "map";
  if (s.name === "causes" || s.name === "why") return "causes";
  if (s.name === "alerts") return "alerts";
  return null;
}

// ---- map scene ---------------------------------------------------------------------------------

export interface MapPoint {
  lat: number;
  lng: number;
  kind: "start" | "end" | "stop";
  label?: string;
}

/** What a screen wants drawn on top of the live traffic map. */
export interface MapScene {
  /** Main route: accent blue with a light casing */
  route?: LatLngTuple[];
  /** Alternative route: dashed grey */
  alternative?: LatLngTuple[];
  /** Multi-stop plan: one polyline per leg */
  legs?: LatLngTuple[][];
  /** A selected road to emphasise (white glow) */
  highlight?: LatLngTuple[];
  points?: MapPoint[];
  /** Fit the map to these points when the scene is set */
  fit?: LatLngTuple[];
  /** Show cause markers (default true) */
  markers?: boolean;
}

export interface MapLayers {
  causes: boolean;
  cameras: boolean;
  crossings: boolean;
}

// ---- "where am I" --------------------------------------------------------------------------------

export interface Here {
  lat: number;
  lng: number;
  /** nearest named place id / name */
  place: string;
  name: string;
  /** street-ish line, e.g. the place's address */
  street: string;
  /** worst traffic level on roads touching that place */
  level: Level;
  /** true when it came from the device's location */
  fromDevice: boolean;
}

export interface Recent {
  id: string;
  name: string;
  address?: string | null;
  to: Location;
  at: number;
}

// ---- context -------------------------------------------------------------------------------------

export interface AppValue {
  // data
  places: Place[];
  segments: Segment[];
  cameras: Camera[];
  clock: ClockState | null;
  slowdowns: SlowdownList | null;
  alerts: TrafficAlert[];
  live: LiveConditions | null;
  /** My notifications (trip / plan / "cleared" alerts), newest first */
  notes: AppNotification[];
  here: Here | null;
  recents: Recent[];
  addRecent: (r: Omit<Recent, "at">) => void;
  backendDown: boolean;
  /** Refetch slowdowns / alerts / live / levels now (after a demo action) */
  refresh: () => void;
  /** Show toasts for notifications returned by an action (e.g. /demo/advance-clock) */
  pushOut: (fresh: AppNotification[]) => void;
  applyClock: (c: ClockState) => void;

  // navigation
  screen: Screen;
  go: (s: Screen) => void;
  back: () => void;
  tab: (t: Tab) => void;
  isDesktop: boolean;

  // map
  scene: MapScene | null;
  setScene: (s: MapScene | null) => void;
  /** Pan/zoom the map to a point or fit a set of points */
  focus: (target: { lat: number; lng: number; zoom?: number } | LatLngTuple[]) => void;
  registerMap: (m: MapHandle | null) => void;
  zoom: (delta: number) => void;
  /** Show predicted traffic at this time instead of now (null = live) */
  mapTime: string | null;
  setMapTime: (t: string | null) => void;
  /** Traffic level per segment id at mapTime (or now) */
  levels: Record<string, Level>;
  layers: MapLayers;
  setLayers: (l: MapLayers) => void;
  /** Cause-marker filter (null = all kinds) */
  causeFilter: string | null;
  setCauseFilter: (k: string | null) => void;
  /** The slowdown whose marker popup is open */
  selected: string | null;
  select: (id: string | null) => void;
}

/** The bits of a Leaflet map the app needs (kept loose so this file doesn't import Leaflet). */
export interface MapHandle {
  setView: (center: LatLngTuple, zoom: number, opts?: object) => unknown;
  fitBounds: (b: LatLngTuple[], opts?: object) => unknown;
  getZoom: () => number;
  setZoom: (z: number) => unknown;
  invalidateSize: () => unknown;
}

const Ctx = createContext<AppValue | null>(null);

export function useApp(): AppValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside <AppProvider>");
  return v;
}

const HOUSTON_BOX = { minLat: 29.4, maxLat: 30.2, minLng: -95.9, maxLng: -94.9 };
const DEFAULT_HERE = "midtown";
const RECENTS_KEY = "blindspot.recents";
const LEVEL_RANK: Record<Level, number> = { light: 0, moderate: 1, heavy: 2 };

function nearestPlace(places: Place[], lat: number, lng: number): Place | null {
  let best: Place | null = null;
  let bestD = Infinity;
  for (const p of places) {
    const d = (p.lat - lat) ** 2 + ((p.lng - lng) * Math.cos((lat * Math.PI) / 180)) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

function readRecents(): Recent[] {
  try {
    return JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [places, setPlaces] = useState<Place[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [clock, setClock] = useState<ClockState | null>(null);
  const [slowdowns, setSlowdowns] = useState<SlowdownList | null>(null);
  const [alerts, setAlerts] = useState<TrafficAlert[]>([]);
  const [live, setLive] = useState<LiveConditions | null>(null);
  const [notes, setNotes] = useState<AppNotification[]>([]);
  const [backendDown, setBackendDown] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [recents, setRecents] = useState<Recent[]>([]);
  const [device, setDevice] = useState<{ lat: number; lng: number } | null>(null);

  const [stack, setStack] = useState<Screen[]>([{ name: "where" }]);
  const screen = stack[stack.length - 1];
  const [isDesktop, setIsDesktop] = useState(false);

  const [scene, setScene] = useState<MapScene | null>(null);
  const [mapTime, setMapTime] = useState<string | null>(null);
  const [predicted, setPredicted] = useState<Record<string, Level>>({});
  const [layers, setLayers] = useState<MapLayers>({ causes: true, cameras: false, crossings: false });
  const [causeFilter, setCauseFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const mapRef = useRef<MapHandle | null>(null);

  // ---- bootstrap + polling ---------------------------------------------------------------
  const applyClock = useCallback((c: ClockState) => setClock(c), []);

  useEffect(() => {
    Promise.all([api.places(), api.segments(), api.cameras(), api.clock()])
      .then(([p, s, c, clk]) => {
        setPlaces(p);
        setSegments(s);
        setCameras(c);
        setClock(clk);
        setBackendDown(false);
      })
      .catch(() => setBackendDown(true));
  }, [refreshKey]);

  useEffect(() => {
    const id = setInterval(
      () =>
        api
          .clock()
          .then((c) => {
            setClock(c);
            setBackendDown(false);
          })
          .catch(() => setBackendDown(true)),
      5000,
    );
    return () => clearInterval(id);
  }, []);

  const clockMinute = clock?.now.slice(0, 16);
  useEffect(() => {
    if (!clockMinute) return;
    Promise.all([api.slowdowns(), api.trafficAlerts(), api.live()])
      .then(([s, a, l]) => {
        setSlowdowns(s);
        setAlerts(a.items);
        setLive(l);
      })
      .catch(() => {});
  }, [clockMinute, refreshKey]);

  useEffect(() => {
    if (!mapTime) return;
    api
      .congestion(mapTime)
      .then((c) => setPredicted(Object.fromEntries(Object.entries(c.scores).map(([k, v]) => [k, levelForScore(v)]))))
      .catch(() => {});
  }, [mapTime, refreshKey]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  // ---- notifications (quiet first load, then toasts via the shell) ----------------------
  const lastNoteId = useRef(0);
  const initialized = useRef(false);
  const toastListeners = useRef(new Set<(n: AppNotification[]) => void>());

  const pushOut = useCallback((fresh: AppNotification[]) => {
    if (!fresh.length) return;
    setNotes((prev) => {
      const seen = new Set(prev.map((n) => n.id));
      return [...fresh.filter((n) => !seen.has(n.id)).sort((a, b) => b.id - a.id), ...prev].slice(0, 200);
    });
    const brandNew = fresh.filter((n) => n.id > lastNoteId.current);
    lastNoteId.current = Math.max(lastNoteId.current, ...fresh.map((n) => n.id));
    if (brandNew.length) toastListeners.current.forEach((fn) => fn(brandNew));
  }, []);

  useEffect(() => {
    const poll = () => {
      if (!initialized.current) {
        api
          .notifications(0)
          .then((existing) => {
            initialized.current = true;
            setNotes(existing);
            lastNoteId.current = Math.max(0, ...existing.map((n) => n.id));
          })
          .catch(() => {});
        return;
      }
      api.notifications(lastNoteId.current).then(pushOut).catch(() => {});
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, [pushOut]);

  // ---- where am I -------------------------------------------------------------------------
  useEffect(() => {
    setRecents(readRecents());
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        const b = HOUSTON_BOX;
        if (lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng) setDevice({ lat, lng });
      },
      () => {},
      { timeout: 5000, maximumAge: 600000 },
    );
  }, []);

  const levels = useMemo<Record<string, Level>>(() => {
    if (mapTime) return predicted;
    const out: Record<string, Level> = {};
    for (const s of slowdowns?.items ?? []) out[s.id] = s.level;
    return out;
  }, [mapTime, predicted, slowdowns]);

  const here = useMemo<Here | null>(() => {
    if (!places.length) return null;
    const base = device ? nearestPlace(places, device.lat, device.lng) : places.find((p) => p.id === DEFAULT_HERE) ?? places[0];
    if (!base) return null;
    let level: Level = "light";
    for (const s of segments) {
      if (s.from_node !== base.id && s.to_node !== base.id) continue;
      const lv = levels[s.id] ?? "light";
      if (LEVEL_RANK[lv] > LEVEL_RANK[level]) level = lv;
    }
    return {
      lat: device?.lat ?? base.lat,
      lng: device?.lng ?? base.lng,
      place: base.id,
      name: base.name,
      street: base.address ?? base.name,
      level,
      fromDevice: !!device,
    };
  }, [places, segments, levels, device]);

  const addRecent = useCallback((r: Omit<Recent, "at">) => {
    setRecents((prev) => {
      const next = [{ ...r, at: Date.now() }, ...prev.filter((x) => x.id !== r.id)].slice(0, 6);
      try {
        localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  // ---- navigation -------------------------------------------------------------------------
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const on = () => setIsDesktop(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const go = useCallback((s: Screen) => {
    setStack((st) => [...st, s].slice(-30));
    setSelected(null);
  }, []);
  const back = useCallback(() => setStack((st) => (st.length > 1 ? st.slice(0, -1) : [{ name: "map" }])), []);
  const tab = useCallback((t: Tab) => setStack((st) => [...st, { name: t } as Screen].slice(-30)), []);

  // Screens own their scene: clear it when the screen changes.
  const screenKey = JSON.stringify(screen);
  useEffect(() => setScene(null), [screenKey]);

  // ---- map handle ---------------------------------------------------------------------------
  const registerMap = useCallback((m: MapHandle | null) => {
    mapRef.current = m;
  }, []);
  const focus = useCallback((t: { lat: number; lng: number; zoom?: number } | LatLngTuple[]) => {
    const m = mapRef.current;
    if (!m) return;
    if (Array.isArray(t)) {
      if (t.length > 1) m.fitBounds(t, { padding: [48, 48], maxZoom: 14 });
      else if (t.length === 1) m.setView(t[0], 14, { animate: true });
    } else {
      m.setView([t.lat, t.lng], t.zoom ?? 14, { animate: true });
    }
  }, []);
  const zoom = useCallback((d: number) => {
    const m = mapRef.current;
    if (m) m.setZoom(m.getZoom() + d);
  }, []);

  const value: AppValue = {
    places,
    segments,
    cameras,
    clock,
    slowdowns,
    alerts,
    live,
    notes,
    here,
    recents,
    addRecent,
    backendDown,
    refresh,
    pushOut,
    applyClock,
    screen,
    go,
    back,
    tab,
    isDesktop,
    scene,
    setScene,
    focus,
    registerMap,
    zoom,
    mapTime,
    setMapTime,
    levels,
    layers,
    setLayers,
    causeFilter,
    setCauseFilter,
    selected,
    select: setSelected,
  };
  return (
    <Ctx.Provider value={value}>
      <ToastBus listeners={toastListeners}>{children}</ToastBus>
    </Ctx.Provider>
  );
}

// Toasts are rendered by the shell; this lets it subscribe to brand-new notifications.
const ToastCtx = createContext<React.MutableRefObject<Set<(n: AppNotification[]) => void>> | null>(null);

function ToastBus({ listeners, children }: { listeners: React.MutableRefObject<Set<(n: AppNotification[]) => void>>; children: ReactNode }) {
  return <ToastCtx.Provider value={listeners}>{children}</ToastCtx.Provider>;
}

export function useNewNotifications(fn: (n: AppNotification[]) => void) {
  const listeners = useContext(ToastCtx);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (!listeners) return;
    const cb = (n: AppNotification[]) => fnRef.current(n);
    listeners.current.add(cb);
    return () => {
      listeners.current.delete(cb);
    };
  }, [listeners]);
}
