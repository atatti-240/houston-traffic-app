"use client";

/**
 * What a Share ETA link (/share/<id>) shows: someone's route on the map and when they should get
 * there, re-checked every minute. Read-only and standalone (no app state, no screen history), so it
 * works opened cold on any phone or computer.
 *  Phone: the map with a sheet over its lower part. Desktop: a 420px panel on the left, like the app.
 */

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Icon, Logo } from "@/components/ui";
import { parseSim } from "@/lib/format";
import { describeShareError, isGone, shareApi, timeOn, type SharedTrip as Trip } from "@/lib/share";
import { C, ICON } from "@/lib/theme";

// Leaflet touches `window`, so the map only renders in the browser.
const ShareMap = dynamic(() => import("@/components/map/ShareMap"), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-map" />,
});

const POLL_MS = 60_000;
const REFRESH_ICON = "M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7";

type State =
  | { kind: "loading" }
  | { kind: "gone" }
  | { kind: "down"; message: string }
  /** `at`: when it was fetched (real time, ms); `error`: the latest refresh failed */
  | { kind: "ok"; trip: Trip; at: number; error: string | null };

function minutesBetween(a: string, b: string): number {
  return Math.round((parseSim(b).getTime() - parseSim(a).getTime()) / 60000);
}

function duration(min: number): string {
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`;
}

function updatedAgo(at: number, now: number): string {
  const m = Math.floor((now - at) / 60000);
  return m <= 0 ? "Updated just now" : `Updated ${m} min ago`;
}

/** Full-page message: expired link, or the API can't be reached before anything loaded. */
function Notice({ title, children, action }: { title: string; children: ReactNode; action: ReactNode }) {
  return (
    <main className="flex h-dvh w-full flex-col items-center justify-center gap-5 bg-bg px-6 text-center text-ink">
      <Logo />
      <div className="flex max-w-[340px] flex-col items-center gap-2">
        <span className="mb-1 flex h-12 w-12 items-center justify-center rounded-full bg-card">
          <Icon d={ICON.clock} size={24} color={C.muted} />
        </span>
        <h1 className="m-0 text-[26px] leading-tight font-bold tracking-[-0.02em]">{title}</h1>
        <p className="m-0 text-[15px] leading-snug text-soft">{children}</p>
      </div>
      {action}
    </main>
  );
}

const pill = "flex h-[52px] cursor-pointer items-center justify-center rounded-[26px] px-6 text-[16px] font-semibold";

function Details({ trip, at, error, now, onRefresh, busy }: { trip: Trip; at: number; error: string | null; now: number; onRefresh: () => void; busy: boolean }) {
  const t = trip;
  const arrived = t.status === "arrived";
  const eta = timeOn(t.eta, t.now);
  const toGo = minutesBetween(t.now, t.eta);
  const untilLeave = minutesBetween(t.now, t.depart_at);
  const change = minutesBetween(t.shared_eta, t.eta);
  const leftMin = Math.max(0, Math.round(t.expires_in_min - (now - at) / 60000));

  let status: ReactNode;
  if (t.status === "not_left")
    status = (
      <>
        Leaving about <span className="font-num">{timeOn(t.depart_at, t.now)}</span>
        {untilLeave > 0 && untilLeave <= 180 && (
          <span className="text-muted">
            {" "}
            · in <span className="font-num">{duration(untilLeave)}</span>
          </span>
        )}
      </>
    );
  else if (!arrived)
    status = (
      <>
        On the way
        {toGo > 0 && (
          <span className="text-muted">
            {" "}
            · about <span className="font-num">{duration(toGo)}</span> to go
          </span>
        )}
      </>
    );

  return (
    <div className="flex flex-col gap-4 px-5 pt-4 pb-8 md:pt-6">
      <div className="flex items-center justify-between gap-3">
        <Logo size={16} />
        <button
          type="button"
          onClick={onRefresh}
          disabled={busy}
          className="flex h-9 cursor-pointer items-center gap-1.5 rounded-[18px] px-2.5 text-[12px] text-muted hover:bg-card disabled:cursor-default"
          aria-label={`${updatedAgo(at, now)}. Check again`}
        >
          <span className="font-num">{busy ? "Checking…" : updatedAgo(at, now)}</span>
          <Icon d={REFRESH_ICON} size={15} className={busy ? "animate-spin" : undefined} />
        </button>
      </div>

      <div className="flex flex-col gap-1.5" aria-live="polite">
        <span className="text-[12px] font-semibold tracking-[0.08em] text-muted uppercase">Live ETA</span>
        <h1 className="m-0 text-[32px] leading-[1.05] font-bold tracking-[-0.02em]">
          {arrived ? "Should be there by now" : <>Arriving about <span className="whitespace-nowrap">{eta}</span></>}
        </h1>
        <span className="text-[15px] text-soft">
          {arrived ? (
            <>
              Expected about <span className="font-num">{eta}</span> at {t.destination_name}
            </>
          ) : (
            <>at {t.destination_name}</>
          )}{" "}
          · <span className="whitespace-nowrap">via {t.main_road}</span>
        </span>
        {status && <span className="text-[14px] text-soft">{status}</span>}
        {t.checked && Math.abs(change) >= 1 && (
          <span className="text-[14px] font-medium" style={{ color: change > 0 ? C.moderate : C.light }}>
            {Math.abs(change)} min {change > 0 ? "later" : "earlier"} than when this was shared
          </span>
        )}
      </div>

      <section className="flex flex-col gap-3 rounded-[18px] bg-card p-4">
        <ol className="m-0 flex list-none flex-col p-0">
          {[
            { color: C.light, name: t.origin_name, time: timeOn(t.depart_at, t.now), label: t.status === "not_left" ? "Leaving" : "Left" },
            { color: C.heavy, name: t.destination_name, time: eta, label: arrived ? "Expected" : "Arriving" },
          ].map((s, i) => (
            <li key={i} className="flex gap-3">
              <span className="flex flex-col items-center" aria-hidden="true">
                <span className="mt-1 h-3.5 w-3.5 shrink-0 rounded-full border-2 border-white" style={{ background: s.color }} />
                {i === 0 && <span className="my-1 w-0.5 flex-1 bg-line" />}
              </span>
              <div className={`flex min-w-0 flex-1 items-baseline justify-between gap-3 ${i === 0 ? "pb-4" : ""}`}>
                <span className="truncate text-[15px] font-semibold">{s.name}</span>
                <span className="shrink-0 text-[13px] text-muted">
                  {s.label} <span className="font-num text-soft">{s.time}</span>
                </span>
              </div>
            </li>
          ))}
        </ol>
        <div className="h-px bg-line" />
        <p className="m-0 text-[13px] leading-snug text-muted">
          {arrived && !t.checked
            ? "Their trip should be over, so this ETA won't change any more."
            : !t.checked
              ? "We couldn't re-check this route, so this is the last ETA we had."
              : t.status === "not_left"
                ? `We re-check traffic, trains and crashes along this ${t.miles} mi route every minute, assuming they leave at ${timeOn(t.depart_at, t.now)} as planned. BlindSpot doesn't track where they are.`
                : `We re-check traffic, trains and crashes on the rest of this ${t.miles} mi route every minute, assuming they left at ${timeOn(t.depart_at, t.now)} as planned. BlindSpot doesn't track where they are.`}
        </p>
      </section>

      {error && (
        <p className="m-0 text-[14px] text-heavy-text" role="alert">
          {error} Showing the last ETA we had.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[13px] text-muted">
        <span>{leftMin > 0 ? `Link works for another ${duration(leftMin)}` : "This link is about to expire"}</span>
        <a href="/" className="font-medium">
          Open BlindSpot →
        </a>
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-4 px-5 pt-4 pb-8 md:pt-6" aria-busy="true">
      <Logo size={16} />
      <div className="flex flex-col gap-2">
        <div className="h-3 w-16 animate-pulse rounded bg-card" />
        <div className="h-9 w-64 animate-pulse rounded-lg bg-card" />
        <div className="h-4 w-48 animate-pulse rounded bg-card" />
      </div>
      <div className="h-32 animate-pulse rounded-[18px] bg-card" />
    </div>
  );
}

export default function SharedTrip({ id }: { id: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [sheet, setSheet] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  const load = useCallback(() => {
    const n = ++seq.current;
    setBusy(true);
    shareApi.get(id).then(
      (trip) => {
        if (n !== seq.current) return;
        setState({ kind: "ok", trip, at: Date.now(), error: null });
        setNow(Date.now());
        setBusy(false);
      },
      (e: unknown) => {
        if (n !== seq.current) return;
        setBusy(false);
        if (isGone(e)) return setState({ kind: "gone" });
        const message = describeShareError(e);
        setState((s) => (s.kind === "ok" ? { ...s, error: message } : { kind: "down", message }));
      },
    );
  }, [id]);

  // Every minute, again when the page comes back into view, and a clock for "Updated N min ago".
  // Not once the link is gone: it won't come back.
  const gone = state.kind === "gone";
  useEffect(() => {
    if (gone) return;
    load();
    const poll = setInterval(load, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, gone]);

  // Phone: the sheet covers the bottom of the map; fit the route into the part above it.
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const mq = window.matchMedia("(min-width: 768px)");
    const measure = () => setSheet(mq.matches ? 0 : el.offsetHeight);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    mq.addEventListener("change", measure);
    measure();
    return () => {
      ro.disconnect();
      mq.removeEventListener("change", measure);
    };
  }, [state.kind]);

  if (state.kind === "gone")
    return (
      <Notice
        title="This link expired"
        action={
          <a href="/" className={pill} style={{ background: C.accent, color: C.onAccent }}>
            Open BlindSpot
          </a>
        }
      >
        Live ETA links stop working 6 hours after the trip starts. Ask whoever sent it for a new one.
      </Notice>
    );
  if (state.kind === "down")
    return (
      <Notice
        title="Can't load this ETA"
        action={
          <button type="button" onClick={load} disabled={busy} className={`${pill} border border-edge-strong text-ink`}>
            {busy ? "Trying…" : "Try again"}
          </button>
        }
      >
        {state.message}
      </Notice>
    );

  const trip = state.kind === "ok" ? state.trip : null;
  return (
    <main className="relative h-dvh w-full overflow-hidden bg-bg text-ink">
      <div className="isolate absolute inset-0 md:left-[420px]">
        <ShareMap route={trip?.geometry ?? null} end={trip?.end ?? null} endLabel={trip?.destination_name} bottom={sheet} />
      </div>
      <div
        ref={panel}
        className="absolute inset-x-0 bottom-0 z-[1000] max-h-[60dvh] overflow-y-auto rounded-t-3xl border-t border-line bg-bg md:inset-y-0 md:right-auto md:left-0 md:max-h-none md:w-[420px] md:rounded-none md:border-t-0 md:border-r"
        style={{ boxShadow: "0 -4px 24px rgba(0,0,0,0.5)" }}
      >
        {state.kind === "ok" ? (
          <Details trip={state.trip} at={state.at} error={state.error} now={now} onRefresh={load} busy={busy} />
        ) : (
          <Skeleton />
        )}
      </div>
    </main>
  );
}
