"use client";

/**
 * Driving mode's engine. Every position (real GPS, the demo's simulated drive, or the trip's start when location is
 * off) goes through `accept`: progress along the course, the voice calls due (lib/drive/voice), off-route and
 * wrong-way tracking. A fix too rough to tell (accuracy over MAX_ACCURACY_M) only moves the dot: guidance keeps going
 * by the last good one. A 1 s tick decides re-plans (lib/drive/reroute): off the route or going the wrong way for a
 * few seconds, a new heavy slowdown ahead, or (quietly) turn-by-turn missing from the route, with a cooldown and
 * backoff; a failed re-plan keeps guiding on the old route. Live data (slowdowns, trains, incidents) comes from the
 * app, refreshed here every POLL_MS while driving (the demo clock may be frozen).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useApp } from "@/components/app/AppContext";
import { drive, handedAvoid, handedRoute, handOff, type DriveTrip, type Fix } from "@/components/drive/store";
import { call } from "@/lib/api";
import { buildCourse, hazards as hazardsOn, locate, type Course, type Progress } from "@/lib/drive/course";
import { offset, type Pt } from "@/lib/drive/geo";
import {
  canReroute,
  failed,
  goingForward,
  isOffRoute,
  isWrongWay,
  MAX_ACCURACY_M,
  nearEnd,
  newHeavyAhead,
  onRoute,
  openGate,
  plannedHeavy,
  recovered,
  STALE_FIX_MS,
  started,
  succeeded,
  trackOffRoute,
  trackWrongWay,
} from "@/lib/drive/reroute";
import { simStep } from "@/lib/drive/simulate";
import { browserSpeaker, primeSpeech, readMuted, writeMuted, type Speaker } from "@/lib/drive/speech";
import { forSpeech, hazardCalls, leadDistances, nextCall, nextHazard, SOON_ENOUGH, turnCalls, type Say } from "@/lib/drive/voice";
import { avoidBody, avoidParam, NO_AVOID, parseAvoid, storedAvoid } from "@/lib/roadrules";
import type { LiveConditions, Location, Route, SlowdownList } from "@/lib/types";

import { hasSteps, replan, ReplanError } from "./replan";
import { useGps, type GpsState } from "./useGps";

const TICK_MS = 1000;
const SIM_TICK_MS = 500;
const POLL_MS = 15_000;
/** Without a GPS answer by then, a reload plans from where the app says you are (or the trip's own start) */
const FIRST_FIX_WAIT_MS = 6000;
/** Farthest the demo's wrong turn goes before it waits for a new route */
const DETOUR_MAX_M = 1500;
/** A route without turn-by-turn asks again for it no sooner than this (s) when the server doesn't say */
const STEPS_RETRY_S = 60;
/** ... and stops asking after this many answers without it that don't say when to try again (out of the area) */
const STEPS_GIVE_UP = 3;
/** Opened this far along the route, the drive is resumed (not started) */
const RESUMED_M = 300;
/** Slower than this (m/s) a heading isn't worth sending with a re-plan */
const HEADING_MPS = 3;
const NO_LOCATION: GpsState[] = ["denied", "off", "unavailable"];

export type RerouteState = { state: "rerouting" | "failed" | "done"; reason: "off" | "slowdown"; road?: string; same?: boolean } | null;
type Reason = "off" | "slowdown" | "steps";

const round = (v: number) => Math.round(v * 1e5) / 1e5;
const rough = (f: Fix) => f.source === "gps" && f.accuracy > MAX_ACCURACY_M;

function startFix(course: Course): Fix | null {
  const p = course.line.points[0];
  if (!p) return null;
  const h = course.line.points.length > 1 ? locate(course, p).heading : null;
  return { lat: p[0], lng: p[1], accuracy: 0, heading: h, speed: null, at: Date.now(), source: "start" };
}

export function useNavigation(trip: DriveTrip) {
  const { slowdowns: appSlow, live: appLive, here } = useApp();
  const toName = trip.toName || "your destination";
  // Trip's Avoid choices: from the drive's own params, else the ones its route was handed over with, else what this
  // device chose last (as Trip does without them)
  const [avoid] = useState(() => {
    const said = trip.avoid ?? handedAvoid(trip);
    return avoidParam(avoidBody(parseAvoid(said) ?? storedAvoid()));
  });
  /** The trip as handed over again with each new route (its Avoid choices kept for a reload) */
  const kept = useMemo<DriveTrip>(() => ({ ...trip, avoid }), [trip, avoid]);

  const [route, setRoute] = useState<Route | null>(() => handedRoute(trip));
  const [loadError, setLoadError] = useState<string | null>(null);
  const course = useMemo(() => (route ? buildCourse(route) : null), [route]);
  // `fix`: the latest (the dot); `nav`: what guidance goes by (the latest good enough to tell)
  const [fixes, setFixes] = useState<{ fix: Fix | null; nav: Fix | null }>({ fix: null, nav: null });
  const { fix, nav: navFix } = fixes;
  const [sim, setSim] = useState({ on: false, factor: 4 });
  const [reroute, setReroute] = useState<RerouteState>(null);
  const [arrived, setArrived] = useState(false);
  const [muted, setMuted] = useState(false);
  const [speech, setSpeech] = useState(true);
  const [voiceBlocked, setVoiceBlocked] = useState(false);
  const [stepsGaveUp, setStepsGaveUp] = useState(false);
  const [data, setData] = useState<{ slowdowns: SlowdownList | null; live: LiveConditions | null }>({ slowdowns: appSlow, live: appLive });

  const speaker = useRef<Speaker | null>(null);
  const said = useRef(new Set<string>());
  const gate = useRef(openGate());
  const off = useRef(onRoute());
  const wrong = useRef(goingForward());
  /** The fix off-route and wrong-way tracking last counted: each fix counts once (the effect that feeds them also runs
   * when live data changes, and a fix from before location was turned off must not count again) */
  const tracked = useRef<Fix | null>(null);
  const seenHeavy = useRef(new Set<string>());
  const baselineFor = useRef<string | null>(null);
  const hint = useRef<{ key: string; along: number } | null>(null);
  const inflight = useRef<AbortController | null>(null);
  /** The latest real GPS fix, even while the demo drives (to go back to when it stops) */
  const lastGps = useRef<Fix | null>(null);
  /** Answers without turn-by-turn that don't say when to try again */
  const noSteps = useRef(0);
  const simState = useRef<{ on: boolean; wasOn: boolean; along: number; key: string; detour: { from: Pt; heading: number; meters: number } | null }>({
    on: false,
    wasOn: false,
    along: 0,
    key: "",
    detour: null,
  });

  // ---- positions ------------------------------------------------------------------------------------
  const accept = useCallback((f: Fix) => {
    drive.setFix(f);
    setFixes((prev) => {
      // Too rough to tell: guidance stays with the last good fix while it's recent
      const keep = rough(f) && prev.nav && !rough(prev.nav) && f.at - prev.nav.at <= STALE_FIX_MS;
      return { fix: f, nav: keep ? prev.nav : f };
    });
  }, []);
  const gps = useGps(
    useCallback(
      (f: Fix) => {
        lastGps.current = f;
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
  // Location turned off mid-drive: the last fix says nothing about being off the route now
  useEffect(() => {
    if (!NO_LOCATION.includes(gps.state)) return;
    off.current = onRoute();
    wrong.current = goingForward();
  }, [gps.state]);

  const progress = useMemo<Progress | null>(() => {
    if (!course) return null;
    const pt: Pt | undefined = navFix ? [navFix.lat, navFix.lng] : course.line.points[0];
    if (!pt) return null;
    return locate(course, pt, hint.current?.key === course.key ? hint.current.along : null);
  }, [course, navFix]);

  const hazards = useMemo(() => (course ? hazardsOn(course, data.live) : []), [course, data.live]);

  // ---- speech ---------------------------------------------------------------------------------------
  useEffect(() => {
    const sp = browserSpeaker();
    sp.muted = readMuted();
    sp.onBlocked = () => setVoiceBlocked(true);
    speaker.current = sp;
    setMuted(sp.muted);
    setSpeech(sp.supported);
    return () => {
      sp.onBlocked = null;
      sp.cancel();
    };
  }, []);

  /** Say it once. Muted or blocked it stays due (said once the voice is back), unless `once` (the intro, arrival). */
  const say = useCallback((s: Say, once = false) => {
    if (said.current.has(s.key)) return;
    const sp = speaker.current;
    const ok = !!sp?.say({ text: forSpeech(s.text), urgent: s.urgent, group: s.group, key: s.key });
    if (!ok && sp?.supported && (sp.muted || sp.blocked) && !once) return;
    said.current.add(s.key);
    s.covers?.forEach((k) => said.current.add(k));
  }, []);

  /** The next turn, now ("In 2 miles, merge onto I-69"): voice back on, or a new route. */
  const sayNext = useCallback(() => {
    const { course: c, progress: p, fix: f } = latest.current;
    if (!c || !p || latest.current.arrived) return;
    // Right at the turn its own call is due anyway
    if (p.toNext <= leadDistances(f ? (f.realSpeed ?? f.speed) : null).near) return;
    const s = nextCall(c.steps, p, `${c.key}|`, trip.toName ?? "");
    if (s) say(s, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [say, trip.toName]);

  const toggleMute = useCallback(() => {
    const sp = speaker.current;
    const next = !(sp?.muted ?? muted);
    if (sp) {
      sp.muted = next;
      if (next) sp.cancel();
      else {
        primeSpeech();
        sp.unblock();
        setVoiceBlocked(false);
      }
    }
    writeMuted(next);
    setMuted(next);
    if (!next) sayNext();
  }, [muted, sayNext]);

  /** The browser wanted a tap before speaking: this is it. */
  const wakeVoice = useCallback(() => {
    primeSpeech();
    speaker.current?.unblock();
    setVoiceBlocked(false);
    sayNext();
  }, [sayNext]);

  // ---- each new position ----------------------------------------------------------------------------
  useEffect(() => {
    if (!course || !progress) return;
    // Guidance on a fix too rough to tell (none better lately): the dot moves, nothing else
    if (navFix && rough(navFix)) return;
    hint.current = { key: course.key, along: progress.along };
    if (!navFix || arrived) return;
    const moving = navFix.source !== "start";
    if (moving && tracked.current !== navFix) {
      tracked.current = navFix;
      off.current = trackOffRoute(off.current, progress.off, navFix.accuracy, navFix.at);
      if (progress.off <= 50)
        wrong.current = trackWrongWay(wrong.current, { heading: navFix.heading, speed: navFix.speed, along: progress.along, roadHeading: progress.heading, at: navFix.at });
    }
    if (moving) {
      if (off.current.since === null && wrong.current.since === null) {
        setReroute((r) => (r?.state === "failed" ? null : r));
        // Back on the route: the next stretch off it is said again
        gate.current = recovered(gate.current);
      }
      if (progress.arrived) {
        setArrived(true);
        setSim((s) => ({ ...s, on: false }));
        say({ key: "arrived", text: `You've arrived at ${toName}`, urgent: true, group: "turn" }, true);
        return;
      }
    }
    // Off the line: the re-plan speaks next, not turns meant for the line
    if (progress.off > 50) return;
    const speed = navFix.realSpeed ?? navFix.speed;
    const prefix = `${course.key}|`;
    const calls = turnCalls(course.steps, progress, speed, said.current, prefix, trip.toName ?? "");
    if (!said.current.has(`${prefix}start`)) {
      const first = !said.current.has("intro");
      said.current.add("intro");
      const { near } = leadDistances(speed);
      let text = "";
      if (first) {
        // "Head southwest on Bagby St" only while you're still on the first leg (not coming back mid-drive)
        const s0 = course.steps[0]?.step;
        const lead = s0 && s0.maneuver.type === "depart" && progress.next === 1 && progress.toNext > near ? s0.instruction : "";
        // Back mid-drive (another screen, a reload): not "Starting"
        const intro = progress.along > RESUMED_M ? `Continuing the route to ${toName}.` : `Starting the route to ${toName}.`;
        text = [intro, lead].filter(Boolean).join(" ");
      } else if (!calls.length && progress.next !== null && progress.toNext > near * SOON_ENOUGH) {
        // A new route (a re-plan): what's next, not "Head southwest" while you're already driving
        const s = nextCall(course.steps, progress, prefix, trip.toName ?? "");
        if (s) calls.push(s);
      }
      const urgent = calls.find((c) => c.urgent);
      if (text && urgent) urgent.text = `${text} ${urgent.text}`; // one line, not one cut short by the other
      else if (text) say({ key: `${prefix}start`, text }, true);
      said.current.add(`${prefix}start`);
    }
    for (const s of calls) say(s);
    for (const s of hazardCalls(hazards, progress.along, speed, said.current)) say(s);
  }, [course, progress, navFix, arrived, hazards, say, toName, trip.toName]);

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

  // What was heavy when a route was planned doesn't count as new: the planner's own traffic for when you'd get there
  // (a rush hour turning heavy on schedule), and the app's slowdowns if they're from before the plan
  useEffect(() => {
    if (!course || !route || !data.slowdowns || baselineFor.current === course.key) return;
    for (const id of plannedHeavy(route.segments)) seenHeavy.current.add(id);
    if (!(Date.parse(data.slowdowns.generated_at) > Date.parse(route.depart_at))) {
      const heavy = new Set(data.slowdowns.items.filter((s) => s.level === "heavy" || s.closed).map((s) => s.id));
      for (const s of course.segments) if (heavy.has(s.id)) seenHeavy.current.add(s.id);
    }
    baselineFor.current = course.key;
  }, [course, route, data.slowdowns]);

  // A route without turn-by-turn asks for it again (quietly), no sooner than the server said
  useEffect(() => {
    if (!route || hasSteps(route)) return;
    const retry = route.directions?.retry_after_s;
    if (retry == null && ++noSteps.current >= STEPS_GIVE_UP) setStepsGaveUp(true);
    gate.current = { ...gate.current, notBefore: Math.max(gate.current.notBefore, Date.now() + (retry ?? STEPS_RETRY_S) * 1000) };
  }, [route]);

  // ---- re-planning ----------------------------------------------------------------------------------
  const latest = useRef({ course, progress, fix: navFix, data, arrived, route, stepsGaveUp, here });
  latest.current = { course, progress, fix: navFix, data, arrived, route, stepsGaveUp, here };

  /** Where a plan starts: the live position (GPS, or the demo's drive) with its heading; else the device's spot (the
   * app's "Your location"); else the trip's own start (a place, or a point); else where the app starts trips (location
   * off); else the route's start. */
  const origin = useCallback((): { origin: Location; heading?: number } | null => {
    const { fix: f, course: c, here: h } = latest.current;
    if (f && f.source !== "start") {
      const moving = f.heading !== null && (f.speed ?? 0) >= HEADING_MPS;
      return { origin: { lat: round(f.lat), lng: round(f.lng) }, ...(moving ? { heading: Math.round(f.heading as number) % 360 } : {}) };
    }
    if (h?.fromDevice && typeof h.start !== "string") return { origin: { lat: round(h.start.lat), lng: round(h.start.lng) } };
    if (trip.from !== undefined) return { origin: trip.from };
    if (h) return { origin: h.start };
    const p = c?.line.points[0];
    return p ? { origin: { lat: round(p[0]), lng: round(p[1]) } } : null;
  }, [trip.from]);

  const body = useCallback(
    (o: { origin: Location; heading?: number }) => ({
      ...o,
      destination: trip.to,
      safety_weight: trip.safety ?? 0,
      safe_path: (trip.safety ?? 0) >= 1,
      // The same Avoid tolls / highways as the trip's own routes
      ...avoidBody(parseAvoid(avoid) ?? NO_AVOID),
    }),
    [trip.to, trip.safety, avoid],
  );

  const doReroute = useCallback(
    async (reason: Reason, road?: string) => {
      const o = origin();
      if (!o) return;
      const oldId = latest.current.route?.id;
      const quiet = reason === "steps";
      // Said once per try in a row: trying again after a failure is shown, not said
      if (!quiet && gate.current.failures === 0)
        say({ key: `reroute:${Date.now()}`, text: reason === "off" ? "Rerouting" : `Heavy traffic ahead on ${road}. Rerouting.`, urgent: true, group: "reroute" }, true);
      gate.current = started(gate.current);
      if (!quiet) setReroute({ state: "rerouting", reason, road });
      const ctl = new AbortController();
      inflight.current = ctl;
      try {
        const r = await replan(body(o), { signal: ctl.signal });
        if (ctl.signal.aborted) return;
        gate.current = succeeded(gate.current, Date.now());
        // Back on the route while the new one was on its way: keep going
        if (reason === "off" && off.current.since === null && wrong.current.since === null) {
          setReroute(null);
          return;
        }
        off.current = onRoute();
        wrong.current = goingForward();
        setRoute(r);
        handOff(kept, r);
        if (quiet) return;
        const same = reason === "slowdown" && !!oldId && r.id === oldId;
        setReroute({ state: "done", reason, road, same });
        if (same) say({ key: `same:${Date.now()}`, text: "This is still the fastest way." }, true);
      } catch (e) {
        if (ctl.signal.aborted) return;
        const retryAfterS = e instanceof ReplanError ? e.retryAfterS : null;
        gate.current = failed(gate.current, Date.now(), retryAfterS);
        if (quiet) {
          if (e instanceof ReplanError && e.noSteps && retryAfterS === null && ++noSteps.current >= STEPS_GIVE_UP) setStepsGaveUp(true);
          return;
        }
        setReroute({ state: "failed", reason, road });
        if (gate.current.failures === 1)
          say({ key: `reroute-failed:${Date.now()}`, text: "Couldn't get a new route right now. Keep going, we'll try again shortly." }, true);
      } finally {
        if (inflight.current === ctl) inflight.current = null;
      }
    },
    [origin, body, say, kept],
  );

  const rerouteRef = useRef(doReroute);
  rerouteRef.current = doReroute;
  useEffect(() => {
    const id = setInterval(() => {
      const { course: c, progress: p, fix: f, data: d, arrived: done, stepsGaveUp: gaveUp } = latest.current;
      if (!c || !p || !f || done) return;
      const now = Date.now();
      // Nothing to re-plan right by the destination (as the crow flies: missing the last turn still re-plans)
      if (!canReroute(gate.current, now) || nearEnd(p.toEnd)) return;
      if (f.source !== "start" && (isOffRoute(off.current, now) || isWrongWay(wrong.current, now))) {
        void rerouteRef.current("off");
        return;
      }
      if (c.steps.length < 2 && !gaveUp) {
        void rerouteRef.current("steps");
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

  // ---- first plan after a reload without the route (Start hands the route over otherwise) ---------------
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setWaited(true), FIRST_FIX_WAIT_MS);
    return () => clearTimeout(t);
  }, []);
  // Plan once there's a GPS fix to plan from, or it's clear there won't be one soon (and the app knows where you are,
  // for a trip without its own start)
  const canPlan =
    !route && !loadError && (fix?.source === "gps" || ((waited || NO_LOCATION.includes(gps.state)) && (trip.from !== undefined || !!here)));
  useEffect(() => {
    if (!canPlan) return;
    const o = origin();
    if (o == null) {
      setLoadError("We don't know where this trip starts.");
      return;
    }
    const ctl = new AbortController();
    replan(body(o), { needSteps: false, signal: ctl.signal }).then(
      (r) => {
        if (ctl.signal.aborted) return;
        setRoute(r);
        handOff(kept, r);
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
      if (s.wasOn) {
        // Stopped: back to where you really are (or the trip's start without location), not the simulated spot
        s.wasOn = false;
        const { course: c, arrived: done } = latest.current;
        const g = lastGps.current;
        hint.current = null;
        if (!done && g) accept({ ...g, at: Date.now() });
        else if (!done && c) {
          const f0 = startFix(c);
          if (f0) accept(f0);
        }
      }
      return;
    }
    s.on = true;
    s.wasOn = true;
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
        accept({ lat: at[0], lng: at[1], accuracy: 5, heading: s.detour.heading, speed: 13.4 * sim.factor, realSpeed: 13.4, at: now, source: "sim" });
        return;
      }
      const st = simStep(c, s.along, SIM_TICK_MS / 1000, sim.factor);
      s.along = st.along;
      accept({ lat: st.at[0], lng: st.at[1], accuracy: 5, heading: st.heading, speed: st.speed, realSpeed: st.speed / sim.factor, at: now, source: "sim" });
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
    /** The latest position (the dot) */
    fix,
    /** The position guidance goes by */
    navFix,
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
    voiceBlocked,
    wakeVoice,
    stepsGaveUp,
    loadError,
    retryLoad: () => setLoadError(null),
    end,
  };
}
