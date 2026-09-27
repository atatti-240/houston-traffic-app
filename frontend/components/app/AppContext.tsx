"use client";

/**
 * App-wide state: data from the API (polled), navigation between screens, what the map shows,
 * and notifications. Screens read everything through `useApp()`.
 *
 * Screens:  where (start) -> trip       map -> cameras       causes -> why       alerts
 *           map / trip -> nearby (gas, EV chargers, parking)
 * Tabs (bottom nav): map | causes | alerts.  "where", "trip" and "nearby" are full-screen flows (no nav).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { PoiKind } from "@/components/places/store";
import { api } from "@/lib/api";
import { addMinutesSim, parseSim } from "@/lib/format";
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
      /** A real place (search result, map dot, saved place): shows its card (hours, phone...) */
      toPlace?: { osm?: string | null; address?: string | null; kind?: string | null };
      /** "tolls", "highways" or "tolls,highways"; omitted = what this device chose last */
      avoid?: string;
    }
  | { name: "map" }
  /** Gas / EV chargers / parking near you, or along `route` (from a trip to `routeTo`) */
  | { name: "nearby"; kind: PoiKind; route?: LatLngTuple[]; routeTo?: string }
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

function parentOf(s: Screen): Screen {
  if (s.name === "why") return { name: "causes" };
  if (s.name === "trip") return { name: "where" };
  return { name: "map" };
}

const POI_KINDS: PoiKind[] = ["fuel", "ev", "parking"];

/** Deep link for a screen: the params `parseScreen` reads. */
function screenUrl(s: Screen): string {
  const q = new URLSearchParams({ screen: s.name });
  if (s.name === "why") q.set("id", s.id);
  if (s.name === "cameras") {
    if (s.area) q.set("area", s.area);
    if (s.camId) q.set("cam", s.camId);
  }
  if (s.name === "trip") {
    if (typeof s.to === "string") q.set("to", s.to);
    if (typeof s.from === "string") q.set("from", s.from);
    if (s.arriveBy) q.set("by", s.arriveBy);
    if (s.safety !== undefined) q.set("safety", String(s.safety));
    if (s.avoid !== undefined) q.set("avoid", s.avoid);
  }
  if (s.name === "nearby") q.set("kind", s.kind);
  return `${window.location.pathname}?${q}`;
}

// Deep links for testing / sharing: ?screen=map|causes|alerts|cameras|why&id=...&area=...
function parseScreen(search: string): Screen | null {
  const q = new URLSearchParams(search);
  const name = q.get("screen");
  const id = q.get("id");
  if (name === "map" || name === "causes" || name === "alerts" || name === "where") return { name };
  if (name === "cameras") return { name, area: q.get("area") ?? undefined, camId: q.get("cam") ?? undefined };
  if (name === "why" && id) return { name, id };
  if (name === "nearby") {
    const kind = q.get("kind") as PoiKind;
    return { name, kind: POI_KINDS.includes(kind) ? kind : "fuel" };
  }
  if (name === "trip" && q.get("to"))
    return {
      name,
      to: q.get("to") as string,
      from: q.get("from") ?? undefined,
      arriveBy: q.get("by") ?? undefined,
      safety: q.get("safety") ? Number(q.get("safety")) : undefined,
      avoid: q.get("avoid") ?? undefined,
    };
  return null;
}

/** The screen stack, mirrored in browser history: stack[i] is the history entry at depth base + i. */
interface Nav {
  stack: Screen[];
  base: number;
}

/** What each of our history entries carries. */
interface NavEntry {
  bsDepth: number;
  bsScreen: Screen;
}

const MAX_STACK = 30;

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
  /** Room to leave around `fit`, in px (e.g. for a bottom sheet over the map) */
  fitPadding?: { topLeft: [number, number]; bottomRight: [number, number] };
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
  /** A real place's OpenStreetMap id (its card shows on the trip) */
  osm?: string | null;
  kind?: string | null;
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
  /** Replace my notifications with what the API has now (after /demo/reset deleted them) */
  resetNotes: () => Promise<void>;
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
  /** Show predicted traffic at this time instead of now (null = live). Map screen only; it keeps its lead as the clock moves. */
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

  const [nav, setNavState] = useState<Nav>({ stack: [{ name: "where" }], base: 0 });
  // Kept in step with `nav` so go/back can push history entries outside a state updater.
  const navRef = useRef(nav);
  const setNav = useCallback((n: Nav) => {
    navRef.current = n;
    setNavState(n);
  }, []);
  // Start on the deep-linked screen, or after a reload on the screen (and depth) of this history entry.
  useEffect(() => {
    const st = window.history.state as Partial<NavEntry> | null;
    const s = st?.bsScreen ?? parseScreen(window.location.search) ?? { name: "where" };
    const depth = typeof st?.bsDepth === "number" ? st.bsDepth : 0;
    setNav({ stack: [s], base: depth });
    // Keep Next's own history state: it drives its popstate handling.
    window.history.replaceState({ ...st, bsDepth: depth, bsScreen: s }, "");
  }, [setNav]);
  const screen = nav.stack[nav.stack.length - 1];
  const [isDesktop, setIsDesktop] = useState(false);

  const [scene, setScene] = useState<MapScene | null>(null);
  // Predicted traffic is a Map-screen view: keep how far ahead of the clock it looks (so it moves with the clock)
  // and drop it on every other screen.
  const [mapAhead, setMapAhead] = useState<number | null>(null);
  const [predicted, setPredicted] = useState<Record<string, Level>>({});
  const [layers, setLayers] = useState<MapLayers>({ causes: true, cameras: false, crossings: false });
  const [causeFilter, setCauseFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const mapRef = useRef<MapHandle | null>(null);

  // ---- bootstrap + polling ---------------------------------------------------------------
  const applyClock = useCallback((c: ClockState) => setClock(c), []);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  // Loaded once, and again whenever the clock poll finds the API up before they have loaded (it was still starting).
  const booted = useRef(false);
  useEffect(() => {
    Promise.all([api.places(), api.segments(), api.cameras(), api.clock()])
      .then(([p, s, c, clk]) => {
        booted.current = true;
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
            if (!booted.current) refresh();
          })
          .catch(() => setBackendDown(true)),
      5000,
    );
    return () => clearInterval(id);
  }, [refresh]);

  // The camera AI confirms (or clears) incidents in real time, even while the demo clock stands still:
  // fetch slowdowns / alerts / live again when its set of incidents changes.
  const cvKey = useRef<string | null>(null);
  useEffect(() => {
    const poll = () =>
      api
        .cvStatus()
        .then((s) => {
          if (cvKey.current !== null && s.incidents_key !== cvKey.current) refresh();
          cvKey.current = s.incidents_key;
        })
        .catch(() => {});
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  // Responses that arrive after a newer request started are dropped (`current`).
  const clockMinute = clock?.now.slice(0, 16);
  useEffect(() => {
    if (!clockMinute) return;
    let current = true;
    Promise.all([api.slowdowns(), api.trafficAlerts(), api.live()])
      .then(([s, a, l]) => {
        if (!current) return;
        setSlowdowns(s);
        setAlerts(a.items);
        setLive(l);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [clockMinute, refreshKey]);

  const mapTime = screen.name === "map" && mapAhead !== null && clock ? addMinutesSim(clock.now, mapAhead) : null;
  const mapMinute = mapTime?.slice(0, 16);
  useEffect(() => {
    if (!mapMinute) return;
    let current = true;
    api
      .congestion(`${mapMinute}:00`)
      .then((c) => {
        if (current) setPredicted(Object.fromEntries(Object.entries(c.scores).map(([k, v]) => [k, levelForScore(v)])));
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [mapMinute, refreshKey]);
  useEffect(() => {
    if (screen.name !== "map") setMapAhead(null);
  }, [screen.name]);
  const setMapTime = useCallback(
    (t: string | null) =>
      setMapAhead(t && clockMinute ? Math.round((parseSim(t).getTime() - parseSim(`${clockMinute}:00`).getTime()) / 60000) : null),
    [clockMinute],
  );

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

  // Bumped by resetNotes: polls started before it are dropped (they may hold deleted notifications).
  const noteGen = useRef(0);
  useEffect(() => {
    const poll = () => {
      const gen = noteGen.current;
      if (!initialized.current) {
        api
          .notifications(0)
          .then((existing) => {
            if (gen !== noteGen.current) return;
            initialized.current = true;
            setNotes(existing);
            lastNoteId.current = Math.max(0, ...existing.map((n) => n.id));
          })
          .catch(() => {});
        return;
      }
      api
        .notifications(lastNoteId.current)
        .then((fresh) => {
          if (gen === noteGen.current) pushOut(fresh);
        })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, [pushOut]);

  // The demo reset deletes every notification on the server: start over from what it has now (quietly).
  const resetNotes = useCallback(async () => {
    const gen = ++noteGen.current;
    setNotes([]);
    const existing = await api.notifications(0);
    if (gen !== noteGen.current) return;
    initialized.current = true;
    setNotes(existing);
    // Ids are never reused, so anything newer than the old last id is still new.
    lastNoteId.current = Math.max(lastNoteId.current, ...existing.map((n) => n.id));
  }, []);

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

  const liveLevels = useMemo<Record<string, Level>>(() => {
    const out: Record<string, Level> = {};
    for (const s of slowdowns?.items ?? []) out[s.id] = s.level;
    return out;
  }, [slowdowns]);
  const levels = mapTime ? predicted : liveLevels;

  // Where you are right now: always live traffic, never a prediction.
  const here = useMemo<Here | null>(() => {
    if (!places.length) return null;
    const base = device ? nearestPlace(places, device.lat, device.lng) : places.find((p) => p.id === DEFAULT_HERE) ?? places[0];
    if (!base) return null;
    let level: Level = "light";
    for (const s of segments) {
      if (s.from_node !== base.id && s.to_node !== base.id) continue;
      const lv = liveLevels[s.id] ?? "light";
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
  }, [places, segments, liveLevels, device]);

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

  // Every screen is a browser history entry (?screen=...), so the system back button / gesture goes back a
  // screen instead of leaving the app. Back and forward land in the popstate handler below.
  // Next rewrites an entry without our fields when history goes back past a reload, so the entry being left
  // gets them again first.
  const markEntry = useCallback(() => {
    const { stack, base } = navRef.current;
    const depth = base + stack.length - 1;
    if (window.history.state?.bsDepth !== depth)
      window.history.replaceState({ bsDepth: depth, bsScreen: stack[stack.length - 1] } satisfies NavEntry, "");
  }, []);
  // Screens gone back from, nearest first: Forward brings back the same objects (and so what Cameras remembers).
  const ahead = useRef<Screen[]>([]);
  const push = useCallback(
    (s: Screen) => {
      markEntry();
      ahead.current = [];
      const { stack, base } = navRef.current;
      const depth = base + stack.length;
      setNav(stack.length < MAX_STACK ? { stack: [...stack, s], base } : { stack: [...stack.slice(1), s], base: base + 1 });
      window.history.pushState({ bsDepth: depth, bsScreen: s } satisfies NavEntry, "", screenUrl(s));
    },
    [markEntry, setNav],
  );
  const go = useCallback(
    (s: Screen) => {
      push(s);
      setSelected(null);
    },
    [push],
  );
  // Tapping the tab you're already on adds no entry (the system back would seem to do nothing).
  const tab = useCallback(
    (t: Tab) => {
      const { stack } = navRef.current;
      if (stack[stack.length - 1].name !== t) push({ name: t });
    },
    [push],
  );
  const back = useCallback(() => {
    const { stack, base } = navRef.current;
    if (base + stack.length > 1) {
      markEntry();
      return window.history.back();
    }
    // With nothing to go back to (opened from a link), go to the screen's natural parent.
    const p = parentOf(stack[0]);
    setNav({ stack: [p], base: 0 });
    window.history.replaceState({ bsDepth: 0, bsScreen: p } satisfies NavEntry, "", screenUrl(p));
  }, [markEntry, setNav]);
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const st = e.state as Partial<NavEntry> | null;
      const { stack, base } = navRef.current;
      // An entry without our fields (see markEntry): its URL still names the screen, but not how deep it is.
      if (typeof st?.bsDepth !== "number" || !st.bsScreen) {
        ahead.current = [];
        return setNav({ stack: [parseScreen(window.location.search) ?? { name: "where" }], base: 0 });
      }
      const i = st.bsDepth - base;
      const same = (a: Screen | undefined, b: Screen) => a !== undefined && JSON.stringify(a) === JSON.stringify(b);
      // Back: keep the screens we have (Cameras remembers what each entry showed, keyed by the object).
      if (i >= 0 && i < stack.length && same(stack[i], st.bsScreen)) {
        ahead.current = [...stack.slice(i + 1), ...ahead.current];
        setNav({ stack: stack.slice(0, i + 1), base });
      } else if (i === stack.length) {
        const next = same(ahead.current[0], st.bsScreen) ? (ahead.current.shift() as Screen) : st.bsScreen;
        if (next === st.bsScreen) ahead.current = [];
        setNav({ stack: [...stack, next], base });
      } else {
        ahead.current = [];
        setNav({ stack: [st.bsScreen], base: st.bsDepth });
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [setNav]);

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
    resetNotes,
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
