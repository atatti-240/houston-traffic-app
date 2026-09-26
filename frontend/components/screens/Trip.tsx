"use client";

/**
 * Trip: when to leave and which way, and why. No design exists for it; it follows the design's
 * language (Why it's slow tiles, dark cards, pill buttons).
 *  Phone: a bottom sheet (max 64dvh) with the route on the map above it. Desktop: the left panel.
 *  Single trip: leave now (/route) or arrive by (/recommend). With extra stops: /plan (best order).
 *  Re-plans when the inputs change and whenever live data is refetched (a train blocking the
 *  route shows up as a reroute).
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

import { useApp, type MapPoint, type MapScene } from "@/components/app/AppContext";
import { BackHeader, Card, Icon, LevelPill, PillButton } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtDayTime, fmtTime, parseSim, toSimIso } from "@/lib/format";
import { CAUSE, C, ICON } from "@/lib/theme";
import type { Confidence, LatLngTuple, Location, PlaceIn, Recommendation, Route, TripPlanRequest } from "@/lib/types";

import { planTrip, withDeadline, type TimedPlan } from "./Trip/plan";
import { dataGeneration, placeName, placePoint, tripLevel } from "./Trip/shared";

const SAFETY_LABELS = ["Fastest", "Mostly fast", "Balanced", "Mostly safe", "Safest"];
const MAX_STOPS = 2;
const WEEKDAYS = [0, 1, 2, 3, 4];

function safetyLabel(w: number): string {
  return SAFETY_LABELS[Math.round(Math.max(0, Math.min(1, w)) * 4)];
}

type Mode = "now" | "by";

/** The slider's starting point from the screen params (a deep link can carry anything). */
function initialSafety(v: number | undefined): number {
  return v !== undefined && Number.isFinite(v) ? Math.round(Math.max(0, Math.min(1, v)) * 4) / 4 : 0;
}

type Result =
  | { kind: "route"; key: string; best: Route; alt: Route | null }
  | { kind: "rec"; key: string; rec: Recommendation }
  | ({ kind: "plan"; key: string } & TimedPlan);

type Watch = { key: string; tripId?: number; planId?: string };

/** What a result is computed from (JSON of it is the request key). */
interface Inputs {
  origin?: Location;
  to?: Location;
  mode: Mode;
  by: string | null;
  safety: number;
  stops: string[];
}

// ---- small helpers -------------------------------------------------------------------------------

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** "HH:MM" about half an hour from now, on a 5-minute mark. */
function defaultArriveBy(now: string | undefined): string {
  const d = now ? parseSim(now) : new Date();
  d.setMinutes(Math.ceil((d.getMinutes() + 30) / 5) * 5, 0, 0);
  return toSimIso(d).slice(11, 16);
}

function minutesBetween(a: string, b: string): number {
  return Math.round((parseSim(b).getTime() - parseSim(a).getTime()) / 60000);
}

/** A time, with the weekday when it's on another day than `ref` (now, or the departure it follows). */
function when(iso: string, ref: string | undefined): string {
  return ref && iso.slice(0, 10) !== ref.slice(0, 10) ? fmtDayTime(iso) : fmtTime(iso);
}

/** "Leave at 7:35 AM", or "Leave Tue at 7:35 AM" when it isn't today. */
function leaveAt(iso: string, now: string | undefined): string {
  if (now && iso.slice(0, 10) !== now.slice(0, 10))
    return `Leave ${parseSim(iso).toLocaleDateString([], { weekday: "short" })} at ${fmtTime(iso)}`;
  return `Leave at ${fmtTime(iso)}`;
}

/** "in 25 min" / "in 1 h 10 min" for the next few hours, else nothing. */
function inTime(min: number | null | undefined): string | null {
  if (min == null || min <= 0 || min > 180) return null;
  if (min < 60) return `in ${min} min`;
  return `in ${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`;
}

function reasonIcon(reason: string): { d: string; color: string } {
  if (reason.startsWith("Avoided") || reason.startsWith("Rerouted")) return { d: ICON.check, color: C.light };
  if (reason.startsWith("Safe Path") || reason.startsWith("Safety setting")) return { d: ICON.shield, color: C.accent };
  if (reason.startsWith("About")) return { d: ICON.clock, color: C.accent };
  return { d: CAUSE.crash.icon, color: C.moderate };
}

function toPlaceIn(loc: Location, name?: string): PlaceIn {
  return typeof loc === "string" ? { place: loc, name } : { lat: loc.lat, lng: loc.lng, name };
}

/** Backend / network errors in the app's words. */
function describeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/failed to fetch|networkerror|load failed/i.test(msg)) return "Can't reach BlindSpot right now.";
  if (/^unknown place/i.test(msg)) return "We don't know that place yet. Pick one from Where to.";
  if (/no open route|unknown node/i.test(msg)) return "No open route there on our road map right now.";
  return `Couldn't plan this trip: ${msg}`;
}

/** Key handling for a two-option radio group: arrows move the choice. */
function arrowChoice<T>(e: KeyboardEvent<HTMLElement>, opts: T[], current: T, pick: (v: T) => void) {
  const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
  if (!d) return;
  e.preventDefault();
  const next = opts[(opts.indexOf(current) + d + opts.length) % opts.length];
  pick(next);
  const group = e.currentTarget;
  requestAnimationFrame(() => group.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
}

/** On a phone the sheet covers the lower 64% of the map: fit the route into the strip above it. */
function sheetPadding(isDesktop: boolean): MapScene["fitPadding"] {
  if (isDesktop || typeof window === "undefined") return undefined;
  return { topLeft: [32, 28], bottomRight: [32, Math.round(window.innerHeight * 0.64) + 20] };
}

// ---- pieces ------------------------------------------------------------------------------------

function Segmented({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  const opts: [Mode, string][] = [
    ["now", "Leave now"],
    ["by", "Arrive by"],
  ];
  return (
    <div
      role="radiogroup"
      aria-label="When"
      onKeyDown={(e) =>
        arrowChoice(
          e,
          opts.map(([m]) => m),
          mode,
          onChange,
        )
      }
      className="flex h-11 min-w-0 flex-1 rounded-[22px] bg-card p-1"
    >
      {opts.map(([m, label]) => {
        const on = mode === m;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(m)}
            className="flex-1 cursor-pointer rounded-[18px] text-[14px] font-semibold whitespace-nowrap"
            style={on ? { background: C.ink, color: "#11141A" } : { color: C.soft }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function SafetySlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const label = safetyLabel(value);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold tracking-[0.08em] text-muted uppercase">Route</span>
        <span className="flex items-center gap-1.5 text-[13px] font-medium" style={{ color: value > 0 ? C.accent : C.soft }}>
          {value > 0 && <Icon d={ICON.shield} size={14} />}
          {label}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-[12px] text-muted">Faster</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.25}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label="Faster or safer route"
          aria-valuetext={label}
          className="bs-range h-6 min-w-0 flex-1 cursor-pointer appearance-none bg-transparent"
          style={{ "--fill": `${value * 100}%` } as CSSProperties}
        />
        <span className="text-[12px] text-muted">Safer</span>
      </div>
      <style>{`
        .bs-range::-webkit-slider-runnable-track { height: 6px; border-radius: 3px; background: linear-gradient(to right, ${C.accent} var(--fill), ${C.line} var(--fill)); }
        .bs-range::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 20px; height: 20px; margin-top: -7px; border-radius: 50%; background: ${C.ink}; border: 3px solid ${C.bg}; box-shadow: 0 0 0 1px ${C.edgeStrong}; }
        .bs-range::-moz-range-track { height: 6px; border-radius: 3px; background: ${C.line}; }
        .bs-range::-moz-range-progress { height: 6px; border-radius: 3px; background: ${C.accent}; }
        .bs-range::-moz-range-thumb { width: 14px; height: 14px; border-radius: 50%; background: ${C.ink}; border: 3px solid ${C.bg}; }
        .bs-range:focus-visible { outline: 2px solid ${C.accent}; outline-offset: 4px; border-radius: 4px; }
      `}</style>
    </div>
  );
}

function Tile({ label, children, tone }: { label: string; children: ReactNode; tone?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[14px] bg-card p-3">
      <span className="truncate text-[12px] text-muted">{label}</span>
      <span className="font-num truncate text-[17px]" style={{ color: tone ?? C.ink }}>
        {children}
      </span>
    </div>
  );
}

/** Yellow heads-up strip (feeds down, plan warnings). */
function Banner({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex items-start gap-2.5 rounded-[14px] px-3.5 py-3 text-[13px] leading-snug"
      style={{ background: "rgba(245,197,24,0.10)", color: C.moderate }}
      role="status"
    >
      <Icon d={CAUSE.crash.icon} size={16} className="mt-px shrink-0" />
      <div className="flex min-w-0 flex-col gap-1">{children}</div>
    </div>
  );
}

function Reasons({ reasons }: { reasons: string[] }) {
  if (!reasons.length) return <span className="text-[14px] text-muted">Nothing unusual on this route right now.</span>;
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {reasons.map((r) => {
        const ic = reasonIcon(r);
        return (
          <li key={r} className="flex gap-2.5 text-[14px] leading-snug text-soft">
            <Icon d={ic.d} size={16} color={ic.color} className="mt-0.5 shrink-0" />
            <span className="min-w-0">{r}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Switch({ on, onChange, children }: { on: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-[14px] bg-card px-4 py-3 text-left text-[14px] font-medium text-ink"
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <span className="h-0 w-5 shrink-0 border-t-[3px] border-dashed" style={{ borderColor: C.muted }} aria-hidden="true" />
        {children}
      </span>
      <span className="relative h-6 w-10 shrink-0 rounded-full transition-colors" style={{ background: on ? C.accent : C.edgeStrong }}>
        <span
          className="absolute top-1 h-4 w-4 rounded-full transition-[left]"
          style={{ left: on ? 20 : 4, background: on ? C.onAccent : C.ink }}
        />
      </span>
    </button>
  );
}

const CONF_COLOR: Record<Confidence, string> = { high: C.soft, medium: C.soft, low: C.heavyText };

function Headline({ leave, inMin, lines, loading }: { leave: string | null; inMin?: number | null; lines?: ReactNode; loading: boolean }) {
  if (!leave)
    return (
      <div className="flex flex-col gap-2" aria-busy={loading}>
        <div className="h-9 w-56 animate-pulse rounded-lg bg-card" />
        <div className="h-4 w-64 animate-pulse rounded bg-card" />
      </div>
    );
  return (
    <div className="flex flex-col gap-1.5" aria-live="polite">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="m-0 text-[32px] leading-[1.05] font-bold tracking-[-0.02em]">{leave}</h1>
        {inTime(inMin) && <span className="font-num text-[13px] text-muted">{inTime(inMin)}</span>}
      </div>
      {lines}
    </div>
  );
}

// ---- screen ------------------------------------------------------------------------------------

export default function Trip() {
  const { screen, places, here, clock, slowdowns, back, setScene, isDesktop, pushOut } = useApp();
  const params = screen.name === "trip" ? screen : null;
  const paramsKey = JSON.stringify(params);

  const [mode, setMode] = useState<Mode>(params?.arriveBy ? "by" : "now");
  const [by, setBy] = useState(params?.arriveBy ?? "");
  const [safety, setSafety] = useState(initialSafety(params?.safety));
  const [stops, setStops] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const [showAlt, setShowAlt] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [watch, setWatch] = useState<Watch | null>(null);
  const [saving, setSaving] = useState(false);
  const [retry, setRetry] = useState(0);

  // Same screen, new parameters (e.g. the demo re-opens a trip): start over from them.
  const [seenParams, setSeenParams] = useState(paramsKey);
  if (seenParams !== paramsKey) {
    setSeenParams(paramsKey);
    setMode(params?.arriveBy ? "by" : "now");
    setBy(params?.arriveBy ?? "");
    setSafety(initialSafety(params?.safety));
    setStops([]);
    setPicking(false);
    setShowAlt(false);
    setWatch(null);
  }

  const to = params?.to;
  const origin: Location | undefined = params?.from ?? here?.place;
  const toName = params?.toName ?? placeName(places, to);
  const fromName = params?.fromName ?? (params?.from ? placeName(places, params.from) : here?.name) ?? "";
  const byOk = /^\d{2}:\d{2}$/.test(by);
  const sameSpot = origin !== undefined && to !== undefined && JSON.stringify(origin) === JSON.stringify(to) && !stops.length;

  // Everything a result depends on. Debounced so typing a time or dragging the slider asks once.
  const inputs = useMemo(
    () => JSON.stringify({ origin, to, mode, by: mode === "by" ? by : null, safety, stops } satisfies Inputs),
    [origin, to, mode, by, safety, stops],
  );
  const key = useDebounced(inputs, 300);
  const generation = dataGeneration(slowdowns);
  const reqId = useRef(0);

  const planRequest = (k: Inputs, watching: boolean): TripPlanRequest | null => {
    if (k.origin === undefined || k.to === undefined) return null;
    return {
      name: `${fromName} → ${toName}`,
      start: toPlaceIn(k.origin, fromName || undefined),
      stops: [
        ...k.stops.map((id) => ({ place: id, name: placeName(places, id) })),
        // The destination stays last; the extra stops go in whatever order is best.
        { ...toPlaceIn(k.to, toName || undefined), fixed_order: true, window_end: k.mode === "by" ? k.by : null },
      ],
      safety_weight: k.safety,
      safe_path: k.safety >= 1,
      watch: watching,
    };
  };

  useEffect(() => {
    const k = JSON.parse(key) as Inputs;
    if (k.origin === undefined || k.to === undefined) return;
    if (JSON.stringify(k.origin) === JSON.stringify(k.to) && !k.stops.length) return;
    if (k.mode === "by" && !/^\d{2}:\d{2}$/.test(k.by ?? "")) return;
    const { origin: o, to: d } = k;
    const body = k.stops.length ? planRequest(k, false) : null;
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    const p: Promise<Result> = body
      ? planTrip(body).then((timed) => ({ kind: "plan", key, ...timed }))
      : k.mode === "by"
        ? api
            .recommend({ origin: o, destination: d, arrive_by: k.by as string, safety_weight: k.safety, safe_path: k.safety >= 1 })
            .then((rec) => ({ kind: "rec", key, rec }))
        : api
            .route({ origin: o, destination: d, safety_weight: k.safety, safe_path: k.safety >= 1 })
            .then((r) => ({ kind: "route", key, best: r.best, alt: r.alternative }));
    p.then(
      (r) => {
        if (id !== reqId.current) return;
        setResult(r);
        setLoading(false);
      },
      (e: unknown) => {
        if (id !== reqId.current) return;
        setError(describeError(e));
        setResult(null);
        setLoading(false);
      },
    );
    // Re-run on new inputs, on every live-data refetch and on "Try again" (not on name lookups).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, generation, retry]);

  // ---- the map: route (+ alternative) or the plan's legs, with start / stops / end ----------
  const startPt = origin !== undefined ? placePoint(places, origin) : null;
  const endPt = to !== undefined ? placePoint(places, to) : null;
  useEffect(() => {
    if (!result) return;
    const pts: MapPoint[] = [];
    if (startPt) pts.push({ ...startPt, kind: "start", label: fromName });
    if (result.kind === "plan") {
      const legs = result.plan.legs.map((l) => l.geometry);
      for (const id of (JSON.parse(result.key) as Inputs).stops) {
        const p = placePoint(places, id);
        if (p) pts.push({ ...p, kind: "stop", label: placeName(places, id) });
      }
      if (endPt) pts.push({ ...endPt, kind: "end", label: toName });
      const all = legs.flat();
      setScene({
        legs,
        points: pts,
        fit: all.length ? all : pts.map((p) => [p.lat, p.lng] as LatLngTuple),
        fitPadding: sheetPadding(isDesktop),
      });
      return;
    }
    const best = result.kind === "rec" ? result.rec.route : result.best;
    const alt = result.kind === "rec" ? result.rec.alternative : result.alt;
    if (endPt) pts.push({ ...endPt, kind: "end", label: toName });
    const shownAlt = showAlt && alt ? alt.geometry : undefined;
    setScene({
      route: best.geometry,
      alternative: shownAlt,
      points: pts,
      fit: [...best.geometry, ...(shownAlt ?? [])],
      fitPadding: sheetPadding(isDesktop),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, showAlt, isDesktop, startPt?.lat, startPt?.lng, endPt?.lat, endPt?.lng]);

  // ---- alerts ---------------------------------------------------------------------------------
  const watching = watch?.key === inputs;
  const canWatchTrip = !stops.length && mode === "by" && byOk && typeof origin === "string" && typeof to === "string";
  const canWatch = stops.length ? true : canWatchTrip;

  async function toggleWatch() {
    if (saving) return;
    setSaving(true);
    setError(null);
    const stop = async (w: Watch) => {
      if (w.tripId !== undefined) await api.deleteTrip(w.tripId);
      if (w.planId) await api.deletePlan(w.planId);
    };
    try {
      if (watching && watch) {
        await stop(watch);
        setWatch(null);
        return;
      }
      // Watching an earlier version of this trip (the inputs changed since): replace it.
      if (watch) {
        await stop(watch).catch(() => {});
        setWatch(null);
      }
      if (stops.length) {
        const body = planRequest(JSON.parse(inputs) as Inputs, true);
        if (!body) return;
        // Watch the plan that's on screen: same departure and deadline.
        const shown = result?.kind === "plan" && result.key === inputs ? result : null;
        const req = { ...withDeadline(body, shown?.deadline), depart_after: shown?.departAfter };
        const plan = await api.plan(req);
        pushOut(plan.notifications ?? []);
        setResult({ kind: "plan", key: inputs, plan, departAfter: shown?.departAfter, deadline: shown?.deadline });
        setWatch({ key: inputs, planId: plan.plan_id });
      } else if (canWatchTrip) {
        const trip = await api.createTrip({
          name: `${fromName} → ${toName}`,
          origin: origin as string,
          destination: to as string,
          arrive_by: by,
          days: WEEKDAYS,
          safe_path: safety >= 1,
          safety_weight: safety,
        });
        setWatch({ key: inputs, tripId: trip.id });
      }
    } catch (e) {
      const why = describeError(e);
      setError(why.startsWith("Couldn't plan") ? `Couldn't update the alert: ${e instanceof Error ? e.message : e}` : why);
    } finally {
      setSaving(false);
    }
  }

  // ---- inputs -----------------------------------------------------------------------------------
  const chooseMode = (m: Mode) => {
    setMode(m);
    if (m === "by" && !byOk) setBy(defaultArriveBy(clock?.now));
  };
  const stopOptions = places.filter((p) => p.id !== origin && p.id !== to && !stops.includes(p.id));
  const now = clock?.now;
  // Arrive by with the time cleared: nothing to plan until there is one.
  const needTime = mode === "by" && !byOk;
  const hidden = sameSpot || needTime;
  // Showing a result for other inputs (debouncing, or the new request is on its way).
  const stale = result !== null && (loading || result.key !== inputs);

  // ---- result -----------------------------------------------------------------------------------
  let head: ReactNode = null;
  let body: ReactNode = null;

  if (result && (result.kind === "route" || result.kind === "rec")) {
    const rec = result.kind === "rec" ? result.rec : null;
    const best = result.kind === "rec" ? result.rec.route : result.best;
    const alt = result.kind === "rec" ? result.rec.alternative : result.alt;
    const conf: Confidence = rec ? rec.confidence_label : best.confidence;
    const minutes = Math.max(1, Math.round(best.total_min));
    const late = rec && !rec.on_time ? Math.max(1, minutesBetween(rec.arrive_by, rec.eta)) : 0;
    const leaveNow = !rec || !rec.on_time || (now ? minutesBetween(now, rec.depart_at) <= 0 : false);
    const b = best.breakdown;
    // Whole minutes that add up to the trip's total (train + closure waits on top of driving).
    const trainMin = b.train_delay_min >= 0.5 ? Math.round(b.train_delay_min) : 0;
    const closureMin = b.closure_wait_min >= 0.5 ? Math.round(b.closure_wait_min) : 0;
    const driveMin = Math.max(1, minutes - trainMin - closureMin);
    const third = closureMin
      ? { label: "Closure wait", value: `+${closureMin} min`, tone: C.heavyText }
      : { label: "Crash risk", value: `${Math.round(b.max_crash_risk * 100)}%`, tone: b.max_crash_risk >= 0.5 ? C.heavyText : undefined };

    head = (
      <Headline
        loading={loading}
        leave={rec && !leaveNow ? leaveAt(rec.depart_at, now) : "Leave now"}
        inMin={!leaveNow && rec && now ? minutesBetween(now, rec.depart_at) : null}
        lines={
          <>
            <span className="text-[14px] text-soft">
              Arrive <span className="font-num">{when(rec ? rec.eta : best.arrive_at, rec ? rec.depart_at : best.depart_at)}</span> ·{" "}
              <span className="font-num">{minutes} min</span> · <span style={{ color: CONF_COLOR[conf] }}>{conf} confidence</span>
            </span>
            {rec && late > 0 && (
              <span className="text-[14px] font-medium text-heavy-text">
                You&apos;ll be about {late} min late for {fmtTime(rec.arrive_by)}
              </span>
            )}
            {rec && rec.on_time && rec.leave_at_safe !== rec.depart_at && (
              <span className="text-[13px] text-muted">
                Can&apos;t be late? Leave by <span className="font-num text-soft">{when(rec.leave_at_safe, rec.depart_at)}</span>
                {rec.data_confidence !== "high" ? " (this route leans on predictions)" : ""}.
              </span>
            )}
          </>
        }
      />
    );

    body = (
      <>
        {best.feeds_down.length > 0 && (
          <Banner>
            <span>
              Live {best.feeds_down.join(", ")} data is down. Using predictions for {best.feeds_down.length > 1 ? "those" : "that"}.
            </span>
          </Banner>
        )}
        <Card>
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[12px] text-muted">Via</span>
              <LevelPill level={tripLevel(best)} />
            </div>
            <h2 className="m-0 text-[16px] leading-snug font-semibold">{best.summary || "Local streets"}</h2>
          </div>
          <div className="h-px bg-line" />
          <h3 className="m-0 text-[13px] font-semibold tracking-[0.08em] text-muted uppercase">Why this way</h3>
          <Reasons reasons={best.reasons} />
        </Card>
        <div className="grid grid-cols-3 gap-2">
          <Tile label="Driving">{driveMin} min</Tile>
          <Tile label="Trains" tone={trainMin ? C.heavyText : undefined}>
            {trainMin ? `+${trainMin} min` : best.crossings.length ? "No wait" : "None"}
          </Tile>
          <Tile label={third.label} tone={third.tone}>
            {third.value}
          </Tile>
        </div>
        {alt && (
          <Switch on={showAlt} onChange={setShowAlt}>
            <span className="min-w-0 truncate">
              Show alternative <span className="font-num text-soft">({Math.max(1, Math.round(alt.total_min))} min)</span>
            </span>
          </Switch>
        )}
      </>
    );
  } else if (result && result.kind === "plan") {
    const plan = result.plan;
    const first = plan.legs[0];
    const last = plan.legs[plan.legs.length - 1];
    const leaveNow = !first || (now ? minutesBetween(now, first.leave_at) <= 0 : false);
    // Late and tight stops already show in the headline and on their legs.
    const warnings = plan.warnings.filter((w) => !/^Can't reach .* before its window ends|is tight: less than/.test(w));
    head = (
      <Headline
        loading={loading}
        leave={first ? (leaveNow ? "Leave now" : leaveAt(first.leave_at, now)) : "No plan"}
        inMin={first && !leaveNow && now ? minutesBetween(now, first.leave_at) : null}
        lines={
          last && (
            <>
              <span className="text-[14px] text-soft">
                Arrive <span className="font-num">{when(last.arrive_at, first.leave_at)}</span> ·{" "}
                <span className="font-num">{plan.drive_min} min</span> driving · {plan.legs.length - 1} stop
                {plan.legs.length === 2 ? "" : "s"} on the way
              </span>
              {plan.status === "late" ? (
                <span className="text-[14px] font-medium text-heavy-text">
                  Late: {plan.late_stops.map((s) => `${s.name} by ${Math.max(1, s.late_min)} min`).join(", ")}
                </span>
              ) : (
                <>
                  {result.deadline && !leaveNow && first.leave_at_safe !== first.leave_at && (
                    <span className="text-[13px] text-muted">
                      Can&apos;t be late? Leave by <span className="font-num text-soft">{when(first.leave_at_safe, first.leave_at)}</span>.
                    </span>
                  )}
                  {plan.saved_min_vs_baseline >= 1 && (
                    <span className="text-[13px] text-muted">
                      Saves <span className="font-num text-soft">{plan.saved_min_vs_baseline} min</span> vs. your order on traffic-only
                      routes.
                    </span>
                  )}
                </>
              )}
            </>
          )
        }
      />
    );
    body = (
      <>
        {warnings.length > 0 && (
          <Banner>
            {warnings.map((w) => (
              <span key={w}>{w}</span>
            ))}
          </Banner>
        )}
        <Card>
          <div className="flex items-baseline justify-between">
            <h2 className="m-0 text-[17px] font-semibold">Best order</h2>
            <span className="text-[12px] text-muted">{safetyLabel(plan.safety_weight)} routes</span>
          </div>
          <ol className="m-0 flex list-none flex-col p-0">
            {plan.legs.map((l, i) => {
              const isLast = i === plan.legs.length - 1;
              return (
                <li key={`${i}-${l.to}`} className="flex gap-3">
                  <span className="flex flex-col items-center" aria-hidden="true">
                    <span
                      className="font-num flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px]"
                      style={isLast ? { background: C.heavy, color: "#11141A" } : { background: C.accent, color: C.onAccent }}
                    >
                      {i + 1}
                    </span>
                    {!isLast && <span className="w-0.5 flex-1 bg-line" />}
                  </span>
                  <div className={`flex min-w-0 flex-1 flex-col gap-1 ${isLast ? "" : "pb-4"}`}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[15px] font-semibold">{l.to}</span>
                      <span className="font-num shrink-0 text-[13px] text-soft">{l.drive_min} min</span>
                    </div>
                    <span className="text-[12px] text-muted">
                      From {l.from} · <span className="font-num">{when(l.leave_at, first.leave_at)}</span> →{" "}
                      <span className="font-num">{when(l.arrive_at, first.leave_at)}</span>
                      {l.wait_min > 0 ? ` · wait ${l.wait_min} min` : ""}
                    </span>
                    {(l.late_min > 0 || l.tight) && (
                      <span className="text-[12px] font-medium" style={{ color: l.late_min > 0 ? C.heavyText : C.moderate }}>
                        {l.late_min > 0 ? `${l.late_min} min late` : "Tight: little room for delays"}
                      </span>
                    )}
                    {l.why[0] && (
                      <span className="flex gap-1.5 text-[12px] leading-snug text-soft">
                        <Icon d={reasonIcon(l.why[0]).d} size={14} color={reasonIcon(l.why[0]).color} className="mt-px shrink-0" />
                        <span className="min-w-0">{l.why[0]}</span>
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </Card>
        {plan.navigate_links?.google && (
          <a href={plan.navigate_links.google} target="_blank" rel="noreferrer" className="text-[14px] font-medium">
            Open in Google Maps →
          </a>
        )}
      </>
    );
  }

  const busy = !result && !error && !hidden;
  // The result on screen is for other inputs (a new one is on its way): don't act on it.
  const outdated = result !== null && result.key !== inputs;

  return (
    <div className="flex flex-col gap-4 px-5 pt-3 pb-8 md:pt-6">
      <BackHeader
        onBack={back}
        label={
          <span className="block truncate">
            From {fromName || "…"} → <span className="font-medium text-ink">{toName}</span>
          </span>
        }
        right={stale && !hidden ? <span className="font-num text-[12px] text-muted">Updating…</span> : undefined}
      />

      {sameSpot ? (
        <Headline
          loading={false}
          leave="You're already there"
          lines={<span className="text-[14px] text-muted">Pick another destination.</span>}
        />
      ) : needTime ? (
        <Headline
          loading={false}
          leave="Arrive by…"
          lines={<span className="text-[14px] text-muted">Pick a time to see when to leave.</span>}
        />
      ) : (
        (head ?? (busy || loading ? <Headline loading leave={null} /> : null))
      )}
      {error && !hidden && (
        <p className="m-0 flex flex-wrap items-baseline gap-x-2 text-[14px] text-heavy-text" role="alert">
          <span>{error}</span>
          {!result && (
            <button type="button" onClick={() => setRetry((n) => n + 1)} className="cursor-pointer text-[14px] font-medium text-accent">
              Try again
            </button>
          )}
        </p>
      )}

      {/* When, and how */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Segmented mode={mode} onChange={chooseMode} />
          {mode === "by" && (
            <input
              type="time"
              value={by}
              onChange={(e) => setBy(e.target.value)}
              aria-label="Arrive by"
              className="font-num h-11 w-[138px] shrink-0 rounded-[22px] border border-edge bg-card px-3.5 text-[15px] text-ink outline-none [color-scheme:dark] focus:border-edge-strong"
            />
          )}
        </div>
        <SafetySlider value={safety} onChange={setSafety} />
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {stops.map((id) => (
              <span key={id} className="flex h-9 items-center gap-2 rounded-[18px] bg-card pr-1 pl-3 text-[14px] font-medium">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: C.accent }} aria-hidden="true" />
                {placeName(places, id)}
                <button
                  type="button"
                  aria-label={`Remove stop ${placeName(places, id)}`}
                  onClick={() => setStops(stops.filter((s) => s !== id))}
                  className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-muted hover:bg-card-hi hover:text-ink"
                >
                  <Icon d={ICON.close} size={14} />
                </button>
              </span>
            ))}
            {stops.length < MAX_STOPS && !picking && (
              <button
                type="button"
                onClick={() => setPicking(true)}
                className="flex h-9 cursor-pointer items-center gap-1.5 rounded-[18px] border border-edge-strong px-3.5 text-[14px] font-medium text-ink"
              >
                <Icon d={ICON.plus} size={16} />
                Add a stop
              </button>
            )}
          </div>
          {picking && (
            <div className="fade-in flex flex-col gap-2.5 rounded-[14px] bg-card p-3">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium text-soft">Stop on the way at</span>
                <button type="button" onClick={() => setPicking(false)} className="cursor-pointer text-[13px] font-medium text-accent">
                  Cancel
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {stopOptions.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      setStops([...stops, p.id]);
                      setPicking(false);
                    }}
                    className="h-9 cursor-pointer rounded-[18px] border border-edge-strong px-3.5 text-[14px] font-medium whitespace-nowrap text-ink hover:bg-card-hi"
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {!hidden && body && <div className={`flex flex-col gap-3 transition-opacity ${stale ? "opacity-60" : ""}`}>{body}</div>}

      {!hidden && result && (
        <div className="flex flex-col gap-2">
          {canWatch ? (
            <PillButton
              variant={watching ? "outline" : "primary"}
              onClick={toggleWatch}
              disabled={saving || (outdated && !watching)}
              aria-pressed={watching}
              title={watching ? "Stop watching" : undefined}
            >
              {watching && <Icon d={ICON.check} size={18} />}
              {watching
                ? stops.length
                  ? "Watching this plan"
                  : "Watching weekdays"
                : stops.length
                  ? "Alert me for this plan"
                  : "Alert me on weekdays"}
            </PillButton>
          ) : (
            <PillButton variant="ghost" disabled>
              <Icon d={ICON.bell} size={18} />
              Alert me
            </PillButton>
          )}
          <span className="text-center text-[12px] text-muted">
            {!canWatch
              ? mode === "by"
                ? "Weekday alerts need a named place."
                : "Pick Arrive by to get told when to leave."
              : stops.length
                ? "We re-check the plan every 5 min and tell you if the order or times change."
                : "We tell you when to leave each weekday, and if a train or crash changes the route."}
          </span>
        </div>
      )}
    </div>
  );
}
