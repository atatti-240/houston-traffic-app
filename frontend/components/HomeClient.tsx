"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "@/lib/api";
import { fmtDayTime, parseSim, toSimIso } from "@/lib/format";
import type {
  AppNotification,
  Camera,
  ClockState,
  Crossing,
  LatLngTuple,
  Location,
  Place,
  Recommendation,
  Segment,
} from "@/lib/types";

import CameraModal from "./CameraModal";
import ClientMap from "./ClientMap";
import DemoRunner, { type DemoActions } from "./DemoRunner";
import type { Layers } from "./MapView";
import { NotificationDrawer, Toasts } from "./Notifications";
import TimeSlider from "./TimeSlider";
import TripPanel, { type PickMode } from "./TripPanel";

type PushState = NotificationPermission | "unsupported";

export default function HomeClient() {
  // Static map data
  const [places, setPlaces] = useState<Place[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [backendDown, setBackendDown] = useState(false);

  // Time
  const [clock, setClock] = useState<ClockState | null>(null);
  const [mapTime, setMapTime] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  // Time-dependent layers
  const [congestion, setCongestion] = useState<Record<string, number>>({});
  const [crashRisk, setCrashRisk] = useState<Record<string, number>>({});
  const [crossings, setCrossings] = useState<Crossing[]>([]);
  const [layers, setLayers] = useState<Layers>({ congestion: true, crash: false, trains: true, cameras: false });

  // Trip planning
  const [origin, setOrigin] = useState<Location | null>("eastend");
  const [destination, setDestination] = useState<Location | null>("medcenter");
  const [arriveBy, setArriveBy] = useState("08:30");
  const [safe, setSafe] = useState(false);
  const [pickMode, setPickMode] = useState<PickMode>(null);
  const [rec, setRec] = useState<Recommendation | null>(null);
  const [showAlt, setShowAlt] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);

  // Notifications
  const [notes, setNotes] = useState<AppNotification[]>([]);
  const [toasts, setToasts] = useState<AppNotification[]>([]);
  const [drawer, setDrawer] = useState(false);
  const [pushState, setPushState] = useState<PushState>("unsupported");
  const lastNoteId = useRef(0);
  const swReg = useRef<ServiceWorkerRegistration | null>(null);

  const clockRef = useRef<string | null>(null);
  useEffect(() => {
    clockRef.current = clock?.now ?? null;
  }, [clock]);

  const [camera, setCamera] = useState<Camera | null>(null);
  const [demo, setDemo] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);

  // ---- bootstrapping -----------------------------------------------------------------
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
  }, [refresh]);

  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window) || !("serviceWorker" in navigator)) return;
    setPushState(Notification.permission);
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((reg) => (swReg.current = reg))
      .catch(() => {});
  }, []);

  // Clock poll (the simulated clock runs in real time on the backend)
  useEffect(() => {
    const id = setInterval(() => api.clock().then(setClock).catch(() => {}), 5000);
    return () => clearInterval(id);
  }, []);

  // Layers for the shown time. Following live time: refetch when the clock's minute changes.
  const clockMinute = clock?.now.slice(0, 16);
  const layerTime = mapTime ?? clockMinute;
  useEffect(() => {
    if (!layerTime) return;
    const when = mapTime ?? undefined;
    Promise.all([api.congestion(when), api.crashRisk(when), api.crossings(when)])
      .then(([c, x, cr]) => {
        setCongestion(c.scores);
        setCrashRisk(x.scores);
        setCrossings(cr.crossings);
      })
      .catch(() => {});
  }, [layerTime, mapTime, refresh]);

  // ---- notifications ------------------------------------------------------------------
  const pushOut = useCallback((fresh: AppNotification[]) => {
    if (!fresh.length) return;
    setNotes((prev) => {
      const seen = new Set(prev.map((n) => n.id));
      const add = fresh.filter((n) => !seen.has(n.id));
      return [...add.sort((a, b) => b.id - a.id), ...prev].slice(0, 100);
    });
    const newest = Math.max(...fresh.map((n) => n.id));
    const brandNew = fresh.filter((n) => n.id > lastNoteId.current);
    lastNoteId.current = Math.max(lastNoteId.current, newest);
    if (!brandNew.length) return;
    setToasts((t) => [...brandNew, ...t].slice(0, 3));
    for (const n of brandNew) {
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== n.id)), 9000);
      if (typeof Notification !== "undefined" && Notification.permission === "granted" && swReg.current) {
        swReg.current.showNotification(n.title, { body: n.body, icon: "/icon-192.png", tag: `n-${n.id}` }).catch(() => {});
      }
    }
  }, []);

  useEffect(() => {
    // First load: fill the drawer quietly; only alerts that arrive after that get toasts.
    api
      .notifications(0)
      .then((existing) => {
        setNotes(existing);
        lastNoteId.current = Math.max(lastNoteId.current, 0, ...existing.map((n) => n.id));
      })
      .catch(() => {});
    const poll = () => api.notifications(lastNoteId.current).then(pushOut).catch(() => {});
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, [pushOut]);

  async function enablePush() {
    if (typeof Notification === "undefined") return;
    setPushState(await Notification.requestPermission());
  }

  // ---- planning -----------------------------------------------------------------------
  const plan = useCallback(async (o: Location, d: Location, by: string, s: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.recommend({ origin: o, destination: d, arrive_by: by, safe_path: s });
      setRec(r);
      setShowAlt(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRec(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const tripKey = `${JSON.stringify(origin)}|${JSON.stringify(destination)}|${arriveBy}|${safe}`;

  const saveTrip = useCallback(async () => {
    if (typeof origin !== "string" || typeof destination !== "string") {
      setError("Saved commutes need named places (pick from the list).");
      return;
    }
    const name = `${places.find((p) => p.id === origin)?.name ?? origin} → ${places.find((p) => p.id === destination)?.name ?? destination}`;
    await api.createTrip({ name, origin, destination, arrive_by: arriveBy, days: [0, 1, 2, 3, 4], safe_path: safe });
    setSavedKey(tripKey);
    const res = await api.advanceClock({ minutes: 0 }); // run the scheduler now
    setClock(res);
    pushOut(res.notifications ?? []);
  }, [origin, destination, arriveBy, safe, places, tripKey, pushOut]);

  function onMapClick(lat: number, lng: number) {
    if (!pickMode) return;
    (pickMode === "origin" ? setOrigin : setDestination)({ lat, lng });
    setPickMode(null);
  }

  function onPlaceClick(p: Place) {
    if (pickMode) {
      (pickMode === "origin" ? setOrigin : setDestination)(p.id);
      setPickMode(null);
    }
  }

  // ---- demo + clock controls ----------------------------------------------------------
  const jumpTo = useCallback(
    async (hhmm: string) => {
      const base = parseSim(clock?.now ?? toSimIso(new Date()));
      const [h, m] = hhmm.split(":").map(Number);
      base.setHours(h, m, 0, 0);
      const res = await api.advanceClock({ to: toSimIso(base) });
      setClock(res);
      setMapTime(null);
      pushOut(res.notifications ?? []);
    },
    [clock, pushOut],
  );

  async function advance(minutes: number) {
    const res = await api.advanceClock({ minutes });
    setClock(res);
    setMapTime(null);
    pushOut(res.notifications ?? []);
  }

  const demoActions: DemoActions = useMemo(
    () => ({
      reset: async () => {
        const c = await api.reset();
        setClock(c);
        setNotes([]);
        setToasts([]);
        setRec(null);
        setSavedKey(null);
        setMapTime(null);
        setLayers({ congestion: true, crash: false, trains: true, cameras: false });
      },
      setClock: jumpTo,
      showMapAt: async (hhmm) => {
        if (!hhmm) return setMapTime(null);
        const base = parseSim(clockRef.current ?? toSimIso(new Date()));
        const [h, m] = hhmm.split(":").map(Number);
        base.setHours(h, m, 0, 0);
        setMapTime(toSimIso(base));
      },
      plan: async (o, d, by, s) => {
        setOrigin(o);
        setDestination(d);
        setArriveBy(by);
        setSafe(s);
        if (s) setLayers((l) => ({ ...l, crash: true }));
        await plan(o, d, by, s);
      },
      saveTrip: async () => {
        await saveTrip();
      },
      block: async (crossingId, minutes) => {
        const res = await api.blockCrossing(crossingId, minutes);
        pushOut(res.notifications);
        setRefresh((r) => r + 1);
      },
      clearBlockages: async () => {
        await api.clearBlockages();
        setRefresh((r) => r + 1);
      },
    }),
    [jumpTo, plan, saveTrip, pushOut],
  );

  // ---- derived map props ----------------------------------------------------------------
  const pointOf = (loc: Location | null): LatLngTuple | null => {
    if (!loc) return null;
    if (typeof loc !== "string") return [loc.lat, loc.lng];
    const p = places.find((x) => x.id === loc);
    return p ? [p.lat, p.lng] : null;
  };

  const unread = notes.length;

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-slate-100 text-slate-900">
      <div className="absolute inset-0">
        <ClientMap
          segments={segments}
          congestion={congestion}
          crashRisk={crashRisk}
          crossings={crossings}
          cameras={cameras}
          places={places}
          route={rec?.route ?? null}
          alternative={rec?.alternative ?? null}
          showAlternative={showAlt}
          origin={pointOf(origin)}
          destination={pointOf(destination)}
          layers={layers}
          onMapClick={onMapClick}
          onPlaceClick={onPlaceClick}
          onCameraClick={setCamera}
        />
      </div>

      {/* Top bar */}
      <header className="absolute inset-x-0 top-0 z-[1000] flex items-center justify-between gap-2 bg-white/95 px-3 py-2 shadow backdrop-blur">
        <div className="min-w-0">
          <div className="truncate font-bold">🚦 Houston Traffic</div>
          <div className="hidden text-xs text-slate-500 sm:block">Know when to leave and which way to go, before traffic hits.</div>
        </div>
        <div className="flex items-center gap-1.5">
          {clock && (
            <div className="hidden rounded-lg bg-slate-100 px-2 py-1 text-right text-xs sm:block">
              <div className="text-[10px] uppercase text-slate-500">Simulated time</div>
              <div className="font-semibold">{fmtDayTime(clock.now)}</div>
            </div>
          )}
          <button onClick={() => advance(15)} className="rounded-lg border border-slate-300 px-2 py-1 text-xs" title="Advance simulated time">
            +15m
          </button>
          <button onClick={() => advance(60)} className="hidden rounded-lg border border-slate-300 px-2 py-1 text-xs sm:block">
            +1h
          </button>
          <button onClick={() => setDemo(true)} className="rounded-lg bg-slate-900 px-2.5 py-1 text-xs font-semibold text-white">
            ▶ Demo
          </button>
          <button onClick={() => setDrawer(true)} className="relative rounded-lg border border-slate-300 px-2 py-1 text-sm" aria-label="Alerts">
            🔔
            {unread > 0 && (
              <span className="absolute -right-1.5 -top-1.5 rounded-full bg-red-600 px-1.5 text-[10px] font-bold text-white">{unread}</span>
            )}
          </button>
        </div>
      </header>

      {backendDown && (
        <div className="absolute left-1/2 top-16 z-[1100] -translate-x-1/2 rounded-lg bg-red-600 px-4 py-2 text-sm text-white shadow">
          Can't reach the API. Start it with <code>make backend</code>.{" "}
          <button className="underline" onClick={() => setRefresh((r) => r + 1)}>
            Retry
          </button>
        </div>
      )}

      {/* Planner: side panel on desktop, bottom sheet on phones */}
      <aside
        className={`absolute z-[1000] overflow-y-auto bg-white/97 shadow-xl backdrop-blur transition-all
          inset-x-0 bottom-0 rounded-t-2xl p-4 ${panelOpen ? "max-h-[58dvh]" : "max-h-14"}
          md:inset-x-auto md:bottom-20 md:left-3 md:top-16 md:max-h-none md:w-[380px] md:rounded-2xl`}
      >
        <button className="mb-2 flex w-full items-center justify-between md:hidden" onClick={() => setPanelOpen(!panelOpen)}>
          <span className="font-semibold">Plan a trip</span>
          <span className="text-slate-500">{panelOpen ? "▾" : "▴"}</span>
        </button>
        <TripPanel
          places={places}
          origin={origin}
          destination={destination}
          setOrigin={setOrigin}
          setDestination={setDestination}
          arriveBy={arriveBy}
          setArriveBy={setArriveBy}
          safe={safe}
          setSafe={setSafe}
          pickMode={pickMode}
          setPickMode={setPickMode}
          onPlan={() => origin && destination && plan(origin, destination, arriveBy, safe)}
          onSave={() => saveTrip().catch((e) => setError(String(e)))}
          loading={loading}
          error={error}
          rec={rec}
          showAlt={showAlt}
          setShowAlt={setShowAlt}
          layers={layers}
          setLayers={setLayers}
          saved={savedKey === tripKey}
        />
      </aside>

      {/* Time slider */}
      <div className="absolute inset-x-3 top-16 z-[999] md:bottom-3 md:left-[400px] md:top-auto">
        <TimeSlider clockNow={clock?.now ?? null} mapTime={mapTime} setMapTime={setMapTime} />
      </div>

      {/* Legend */}
      <div className="absolute bottom-20 right-3 z-[999] hidden rounded-xl bg-white/95 p-2 text-[11px] shadow md:block">
        <div className="mb-1 font-semibold">Predicted congestion</div>
        <div className="h-2 w-40 rounded" style={{ background: "linear-gradient(90deg, rgb(34,197,94), rgb(234,179,8), rgb(249,115,22), rgb(220,38,38))" }} />
        <div className="flex justify-between text-slate-500">
          <span>free flow</span>
          <span>jammed</span>
        </div>
        <div className="mt-1.5 flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-full border border-slate-700 bg-orange-400" /> crossing (size = train chance)
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-full border-2 border-red-600 bg-slate-900" /> blocked right now
        </div>
      </div>

      <Toasts toasts={toasts} dismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
      <NotificationDrawer open={drawer} onClose={() => setDrawer(false)} items={notes} pushState={pushState} onEnablePush={enablePush} />
      <CameraModal camera={camera} onClose={() => setCamera(null)} />
      {demo && <DemoRunner actions={demoActions} onExit={() => setDemo(false)} />}
    </main>
  );
}
