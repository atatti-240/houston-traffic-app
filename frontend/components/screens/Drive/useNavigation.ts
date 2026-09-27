"use client";

/**
 * Driving mode's engine. Every position (real GPS, the demo's simulated drive, or the trip's start when location is
 * off) goes through `accept`: progress along the course, the voice calls due (lib/drive/voice), off-route tracking.
 * A 1 s tick decides re-plans (lib/drive/reroute): off the route for a few seconds, or a new heavy slowdown ahead,
 * with a cooldown and backoff; a failed re-plan keeps guiding on the old route. Live data (slowdowns, trains,
 * incidents) comes from the app, refreshed here every POLL_MS while driving (the demo clock may be frozen).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useApp } from "@/components/app/AppContext";
import { drive, handedRoute, handOff, type DriveTrip, type Fix } from "@/components/drive/store";
import { call } from "@/lib/api";
import { buildCourse, hazards as hazardsOn, locate, type Course, type Progress } from "@/lib/drive/course";
import { offset, type Pt } from "@/lib/drive/geo";
import { canReroute, failed, isOffRoute, NEAR_END_M, newHeavyAhead, onRoute, openGate, started, succeeded, trackOffRoute } from "@/lib/drive/reroute";
import { simStep } from "@/lib/drive/simulate";
import { browserSpeaker, readMuted, writeMuted, type Speaker } from "@/lib/drive/speech";
import { hazardCalls, leadDistances, nextHazard, turnCalls, type Say } from "@/lib/drive/voice";
import type { LiveConditions, Location, Route, SlowdownList } from "@/lib/types";

import { replan, ReplanError } from "./replan";
import { useGps, type GpsState } from "./useGps";

const TICK_MS = 1000;
const SIM_TICK_MS = 500;
const POLL_MS = 15_000;
/** Without a GPS answer by then, a reload plans from the trip's start */
const FIRST_FIX_WAIT_MS = 6000;
/** Farthest the demo's wrong turn goes before it waits for a new route */
const DETOUR_MAX_M = 1500;
const NO_LOCATION: GpsState[] = ["denied", "off", "unavailable"];

export type RerouteState = { state: "rerouting" | "failed" | "done"; reason: "off" | "slowdown"; road?: string; same?: boolean } | null;

const round = (v: number) => Math.round(v * 1e5) / 1e5;

function startFix(course: Course): Fix | null {
  const p = course.line.points[0];
  if (!p) return null;
  const h = course.line.points.length > 1 ? locate(course, p).heading : null;
  return { lat: p[0], lng: p[1], accuracy: 0, heading: h, speed: null, at: Date.now(), source: "start" };
}

export function useNavigation(trip: DriveTrip) {
  const { slowdowns: appSlow, live: appLive } = useApp();
  const toName = trip.toName || "your destination";

  const [route, setRoute] = useState<Route | null>(() => handedRoute(trip));
  const [loadError, setLoadError] = useState<string | null>(null);
  const course = useMemo(() => (route ? buildCourse(route) : null), [route]);
  const [fix, setFix] = useState<Fix | null>(null);
  const [sim, setSim] = useState({ on: false, factor: 4 });
  const [reroute, setReroute] = useState<RerouteState>(null);
  const [arrived, setArrived] = useState(false);
  const [muted, setMuted] = useState(false);
  const [speech, setSpeech] = useState(true);
  const [data, setData] = useState<{ slowdowns: SlowdownList | null; live: LiveConditions | null }>({ slowdowns: appSlow, live: appLive });

  const speaker = useRef<Speaker | null>(null);
  const said = useRef(new Set<string>());
  const gate = useRef(openGate());
  const off = useRef(onRoute());
  const seenHeavy = useRef(new Set<string>());
  const baselineFor = useRef<string | null>(null);
  const hint = useRef<{ key: string; along: number } | null>(null);
  const inflight = useRef<AbortController | null>(null);
  const simState = useRef<{ on: boolean; along: number; key: string; detour: { from: Pt; heading: number; meters: number } | null }>({
    on: false,
    along: 0,
    key: "",
    detour: null,
  });

  // ---- positions ------------------------------------------------------------------------------------
  const accept = useCallback((f: Fix) => {
    drive.setFix(f);
    setFix(f);
  }, []);
  const gps = useGps(
    useCallback(
      (f: Fix) => {
        if (!simState.current.on) accept(f);
      },
      [accept],
    ),
  );

  // Location off: show the trip from its start (until the demo drive moves it)
  useEffect(() => {
    if (!course || fix || !NO_LOCATION.includes(gps.state)) return;
    const f = startFix(course);
    if (f) accept(f);
  }, [course, fix, gps.state, accept]);

  const progress = useMemo<Progress | null>(() => {
    if (!course) return null;
    const pt: Pt | undefined = fix ? [fix.lat, fix.lng] : course.line.points[0];
    if (!pt) return null;
    return locate(course, pt, hint.current?.key === course.key ? hint.current.along : null);
  }, [course, fix]);

  const hazards = useMemo(() => (course ? hazardsOn(course, data.live) : []), [course, data.live]);

  // ---- speech ---------------------------------------------------------------------------------------
  useEffect(() => {
    const sp = browserSpeaker();
    sp.muted = readMuted();
    speaker.current = sp;
    setMuted(sp.muted);
    setSpeech(sp.supported);
    return () => sp.cancel();
  }, []);

  const say = useCallback((s: Say) => {
    if (said.current.has(s.key)) return;
    said.current.add(s.key);
    s.covers?.forEach((k) => said.current.add(k));
    speaker.current?.say({ text: s.text, urgent: s.urgent, group: s.group });
  }, []);

  const toggleMute = useCallback(() => {
    const sp = speaker.current;
    const next = !(sp?.muted ?? muted);
    if (sp) {
      sp.muted = next;
      if (next) sp.cancel();
    }
    writeMuted(next);
    setMuted(next);
  }, [muted]);

  // ---- each new position ----------------------------------------------------------------------------
  useEffect(() => {
    if (!course || !progress) return;
    hint.current = { key: course.key, along: progress.along };
    if (!fix || arrived) return;
    const moving = fix.source !== "start";
    if (moving) {
      off.current = trackOffRoute(off.current, progress.off, fix.accuracy, fix.at);
      if (off.current.since === null) setReroute((r) => (r?.state === "failed" ? null : r));
      if (progress.arrived) {
        setArrived(true);
        setSim((s) => ({ ...s, on: false }));
        say({ key: "arrived", text: `You've arrived at ${toName}`, urgent: true, group: "turn" });
        return;
      }
    }
    // Off the line: the re-plan speaks next, not turns meant for the line
    if (progress.off > 50) return;
    const prefix = `${course.key}|`;
    if (!said.current.has(`${prefix}start`)) {
      const first = !said.current.has("intro");
      said.current.add("intro");
      const s0 = course.steps[0]?.step;
      const { near } = leadDistances(fix.speed);
      const lead = s0 && s0.maneuver.type === "depart" && !(progress.next !== null && progress.toNext <= near) ? s0.instruction : "";
      const text = [first ? `Starting the route to ${toName}.` : "", lead].filter(Boolean).join(" ");
      if (text) say({ key: `${prefix}start`, text });
      else said.current.add(`${prefix}start`);
    }
    for (const s of turnCalls(course.steps, progress, fix.speed, said.current, prefix, trip.toName ?? "")) say(s);
    for (const s of hazardCalls(hazards, progress.along, fix.speed, said.current)) say(s);
  }, [course, progress, fix, arrived, hazards, say, toName, trip.toName]);

  // ---- live data ------------------------------------------------------------------------------------
  useEffect(() => {
    if (appSlow) setData((d) => ({ ...d, slowdowns: appSlow }));
  }, [appSlow]);
  useEffect(() => {
    if (appLive) setData((d) => ({ ...d, live: appLive }));
  }, [appLive]);
  useEffect(() => {
    let alive = true;
    const opts = () => (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? { signal: AbortSignal.timeout(8000) } : {});
    const id = setInterval(() => {
      Promise.all([call<SlowdownList>("/slowdowns", opts()), call<LiveConditions>("/live", opts())]).then(
        ([slowdowns, live]) => alive && setData({ slowdowns, live }),
        () => {},
      );
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // What was already heavy when a route was planned doesn't count as new
  useEffect(() => {
    if (!course || !data.slowdowns || baselineFor.current === course.key) return;
    const heavy = new Set(data.slowdowns.items.filter((s) => s.level === "heavy" || s.closed).map((s) => s.id));
    for (const s of course.segments) if (heavy.has(s.id)) seenHeavy.current.add(s.id);
    baselineFor.current = course.key;
  }, [course, data.slowdowns]);

  // ---- re-planning ----------------------------------------------------------------------------------
  const latest = useRef({ course, progress, fix, data, arrived, route });
  latest.current = { course, progress, fix, data, arrived, route };

  const origin = useCallback((): Location | null => {
    const { fix: f, course: c } = latest.current;
    if (f && f.source !== "start") return { lat: round(f.lat), lng: round(f.lng) };
    if (trip.from !== undefined) return trip.from;
    const p = c?.line.points[0];
    return p ? { lat: round(p[0]), lng: round(p[1]) } : null;
  }, [trip.from]);

  const body = useCallback(
    (o: Location) => ({ origin: o, destination: trip.to, safety_weight: trip.safety ?? 0, safe_path: (trip.safety ?? 0) >= 1 }),
    [trip.to, trip.safety],
  );

  const doReroute = useCallback(
    async (reason: "off" | "slowdown", road?: string) => {
      const o = origin();
      if (!o) return;
      const oldId = latest.current.route?.id;
      // Said once per try in a row: trying again after a failure is shown, not said
      if (gate.current.failures === 0)
        say({ key: `reroute:${Date.now()}`, text: reason === "off" ? "Rerouting" : `Heavy traffic ahead on ${road}. Rerouting.`, urgent: true, group: "reroute" });
      gate.current = started(gate.current);
      setReroute({ state: "rerouting", reason, road });
      const ctl = new AbortController();
      inflight.current = ctl;
      try {
        const r = await replan(body(o), { signal: ctl.signal });
        if (ctl.signal.aborted) return;
        gate.current = succeeded(gate.current, Date.now());
        // Back on the route while the new one was on its way: keep going
        if (reason === "off" && off.current.since === null) {
          setReroute(null);
          return;
        }
        off.current = onRoute();
        setRoute(r);
        handOff(trip, r);
        const same = reason === "slowdown" && !!oldId && r.id === oldId;
        setReroute({ state: "done", reason, road, same });
        if (same) say({ key: `same:${Date.now()}`, text: "This is still the fastest way." });
      } catch (e) {
        if (ctl.signal.aborted) return;
        gate.current = failed(gate.current, Date.now(), e instanceof ReplanError ? e.retryAfterS : null);
        setReroute({ state: "failed", reason, road });
        if (gate.current.failures === 1)
          say({ key: `reroute-failed:${Date.now()}`, text: "Couldn't get a new route right now. Keep going, we'll try again shortly." });
      } finally {
        if (inflight.current === ctl) inflight.current = null;
      }
    },
    [origin, body, say, trip],
  );

  const rerouteRef = useRef(doReroute);
  rerouteRef.current = doReroute;
  useEffect(() => {
    const id = setInterval(() => {
      const { course: c, progress: p, fix: f, data: d, arrived: done } = latest.current;
      if (!c || !p || !f || done) return;
      const now = Date.now();
      if (!canReroute(gate.current, now) || p.remainingM <= NEAR_END_M) return;
      if (f.source !== "start" && isOffRoute(off.current, now)) {
        void rerouteRef.current("off");
        return;
      }
      if (baselineFor.current !== c.key || !d.slowdowns) return;
      const heavy = new Set(d.slowdowns.items.filter((s) => s.level === "heavy" || s.closed).map((s) => s.id));
      const seg = newHeavyAhead(c.segments, p.along, heavy, seenHeavy.current);
      if (seg) {
        seenHeavy.current.add(seg.id);
        void rerouteRef.current("slowdown", seg.name);
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, []);

  // "New route" shows for a few seconds
  useEffect(() => {
    if (reroute?.state !== "done") return;
    const t = setTimeout(() => setReroute((r) => (r?.state === "done" ? null : r)), 6000);
    return () => clearTimeout(t);
  }, [reroute]);

  // ---- first plan after a reload (Start hands the route over otherwise) --------------------------------
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setWaited(true), FIRST_FIX_WAIT_MS);
    return () => clearTimeout(t);
  }, []);
  // Plan once there's a GPS fix to plan from, or it's clear there won't be one soon
  const canPlan = !route && !loadError && (fix?.source === "gps" || waited || NO_LOCATION.includes(gps.state));
  useEffect(() => {
    if (!canPlan) return;
    const f = latest.current.fix;
    const o: Location | undefined = f?.source === "gps" ? { lat: round(f.lat), lng: round(f.lng) } : trip.from;
    if (o === undefined) {
      setLoadError("We don't know where this trip starts.");
      return;
    }
    const ctl = new AbortController();
    replan(body(o), { needSteps: false, signal: ctl.signal }).then(
      (r) => {
        if (ctl.signal.aborted) return;
        setRoute(r);
        handOff(trip, r);
      },
      (e: unknown) => {
        if (!ctl.signal.aborted) setLoadError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => ctl.abort();
    // Asks once when it can (a new fix every second doesn't ask again); Try again clears the error
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPlan]);

  // ---- the demo's simulated drive -------------------------------------------------------------------
  useEffect(() => {
    const s = simState.current;
    if (!sim.on) {
      s.on = false;
      s.detour = null;
      return;
    }
    s.on = true;
    s.key = ""; // start from wherever the dot is
    const id = setInterval(() => {
      const { course: c, fix: f } = latest.current;
      if (!c) return;
      if (s.key !== c.key) {
        s.key = c.key;
        s.along = f ? locate(c, [f.lat, f.lng]).along : 0;
        s.detour = null; // a new route ends the wrong turn
      }
      const now = Date.now();
      if (s.detour) {
        // Hold still while the new route is on its way
        if (!gate.current.busy) s.detour.meters = Math.min(DETOUR_MAX_M, s.detour.meters + 13.4 * sim.factor * (SIM_TICK_MS / 1000));
        const at = offset(s.detour.from, s.detour.heading, s.detour.meters);
        accept({ lat: at[0], lng: at[1], accuracy: 5, heading: s.detour.heading, speed: 13.4 * sim.factor, at: now, source: "sim" });
        return;
      }
      const st = simStep(c, s.along, SIM_TICK_MS / 1000, sim.factor);
      s.along = st.along;
      accept({ lat: st.at[0], lng: st.at[1], accuracy: 5, heading: st.heading, speed: st.speed, at: now, source: "sim" });
      if (st.done) setSim((x) => ({ ...x, on: false }));
    }, SIM_TICK_MS);
    return () => {
      clearInterval(id);
      s.on = false;
    };
  }, [sim.on, sim.factor, accept]);

  /** Demo: leave the route to the right (to show a re-plan). */
  const wrongTurn = useCallback(() => {
    const s = simState.current;
    const { fix: f, progress: p } = latest.current;
    if (!s.on || !f || !p) return;
    s.detour = { from: [f.lat, f.lng], heading: (p.heading + 90) % 360, meters: 0 };
  }, []);

  // ---- screen on, and cleanup -------------------------------------------------------------------------
  useEffect(() => {
    drive.start();
    let lock: { release: () => Promise<void> } | null = null;
    let alive = true;
    const wake = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } };
    const ask = () => {
      if (!wake.wakeLock || document.visibilityState !== "visible") return;
      wake.wakeLock.request("screen").then(
        (l) => {
          if (alive) lock = l;
          else l.release().catch(() => {});
        },
        () => {},
      );
    };
    ask();
    document.addEventListener("visibilitychange", ask);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", ask);
      lock?.release().catch(() => {});
      inflight.current?.abort();
      drive.stop();
    };
  }, []);

  /** End: quiet, stop the demo drive and any re-plan on its way. */
  const end = useCallback(() => {
    speaker.current?.cancel();
    simState.current.on = false;
    setSim((s) => ({ ...s, on: false }));
    inflight.current?.abort();
  }, []);

  return {
    route,
    course,
    progress,
    fix,
    gps,
    hazards,
    ahead: progress ? nextHazard(hazards, progress.along) : null,
    reroute,
    arrived,
    sim,
    setSim,
    wrongTurn,
    muted,
    toggleMute,
    speech,
    loadError,
    retryLoad: () => setLoadError(null),
    end,
  };
}
