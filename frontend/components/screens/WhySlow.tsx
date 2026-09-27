"use client";

/** "Why it's slow" for one road (design "Why it's slow"): status / delay / speed tiles, speed over
 * the last 2 hours, what's causing it (share of delay) and "Notify me when it clears".
 * The map (desktop) highlights the road and fits to it. */

import { useEffect, useRef, useState, type ReactNode } from "react";

import { useApp } from "@/components/app/AppContext";
import { BackHeader, Card, PillButton, Title } from "@/components/ui";
import { SpeedLimitSign } from "@/components/ui/SpeedLimitSign";
import { api } from "@/lib/api";
import { parseSim } from "@/lib/format";
import { CAUSE, C, LEVEL, type Level } from "@/lib/theme";
import type { SlowdownCause, SlowdownDetail } from "@/lib/types";

/** Label color on the colored Status tile (a dark shade of the level color, like the design). */
const STATUS_LABEL: Record<Level, string> = { heavy: "#3A0D0D", moderate: "#4A3A00", light: "#0B3A1E" };
const DELAY_COLOR: Record<Level, string> = { heavy: C.heavyText, moderate: C.moderate, light: C.ink };

// ---- speed chart -----------------------------------------------------------------------------

const W = 318;
const PLOT_TOP = 6;
const PLOT_BOTTOM = 82;
const MONO = "var(--font-plex-mono), IBM Plex Mono, monospace";
/** IBM Plex Mono advance width is 0.6em: 6px per character at 10px. */
const textW = (s: string) => s.length * 6;

function clockLabel(iso: string): string {
  const d = parseSim(iso);
  return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function SpeedChart({ h }: { h: SlowdownDetail["history"] }) {
  const pts = h.points;
  if (pts.length < 2) return <p className="m-0 text-[13px] text-muted">Not enough readings yet.</p>;

  const t0 = parseSim(pts[0].t).getTime();
  const t1 = Math.max(parseSim(pts[pts.length - 1].t).getTime(), t0 + 60_000);
  const x = (iso: string) => Math.min(W, Math.max(0, ((parseSim(iso).getTime() - t0) / (t1 - t0)) * W));
  const top = Math.max(h.free_flow_mph, ...pts.map((p) => p.mph)) * 1.05 || 1;
  const y = (mph: number) => PLOT_BOTTOM - (Math.max(0, mph) / top) * (PLOT_BOTTOM - PLOT_TOP);

  const line = pts.map((p) => `${x(p.t).toFixed(1)},${y(p.mph).toFixed(1)}`).join(" ");
  const yUsual = y(h.usual_mph);
  const usualText = `usual ${Math.round(h.usual_mph)}`;

  // Marker labels at the top; stagger rows when they would overlap, flip left near the right edge.
  const placed: { x0: number; x1: number; y: number }[] = [];
  const markers = h.markers
    .filter((m) => {
      const t = parseSim(m.t).getTime();
      return t >= t0 && t <= t1;
    })
    .map((m) => {
      const mx = Math.max(1, Math.min(W - 1, x(m.t)));
      const w = textW(m.label);
      const right = mx + 6 + w <= W;
      const x0 = right ? mx + 6 : mx - 6 - w;
      let ty = 14;
      while (placed.some((p) => p.y === ty && x0 < p.x1 + 6 && x0 + w > p.x0 - 6) && ty < 50) ty += 12;
      placed.push({ x0, x1: x0 + w, y: ty });
      return { ...m, mx, tx: right ? mx + 6 : mx - 6, anchor: (right ? "start" : "end") as "start" | "end", ty };
    });

  // "usual N" sits just above its dashed line, or just below it when the speed line (or a marker
  // label) runs through that spot.
  const xs = pts.map((p) => x(p.t));
  const ys = pts.map((p) => y(p.mph));
  const lineYAt = (px: number) => {
    for (let i = 1; i < xs.length; i++) {
      if (px <= xs[i]) return ys[i - 1] + ((px - xs[i - 1]) / (xs[i] - xs[i - 1] || 1)) * (ys[i] - ys[i - 1]);
    }
    return ys[ys.length - 1];
  };
  const uw = textW(usualText);
  let lineLo = Infinity;
  let lineHi = -Infinity;
  for (let px = 0; px <= uw + 4; px += 2) {
    const v = lineYAt(px);
    lineLo = Math.min(lineLo, v);
    lineHi = Math.max(lineHi, v);
  }
  const clash = (base: number) =>
    base < 9 ||
    base > PLOT_BOTTOM + 1 ||
    !(lineHi + 2 < base - 8 || lineLo - 2 > base + 1) ||
    placed.some((p) => Math.abs(p.y - base) < 11 && p.x0 < uw + 4);
  const above = yUsual - 5;
  const below = yUsual + 12;
  const uy = !clash(above) ? above : !clash(below) ? below : yUsual < 40 ? below : above;
  const halo = { stroke: C.card, strokeWidth: 3, strokeLinejoin: "round" as const, paintOrder: "stroke" };

  const first = pts[0];
  const last = pts[pts.length - 1];
  const summary = `Speed went from ${Math.round(first.mph)} mph at ${clockLabel(first.t)} to ${Math.round(last.mph)} mph now; usual for this time is ${Math.round(
    h.usual_mph,
  )} mph${markers.length ? `. ${markers.map((m) => m.label).join(", ")}` : ""}.`;

  return (
    <svg viewBox={`0 0 ${W} 96`} width="100%" role="img" aria-label={summary} style={{ display: "block", overflow: "visible" }}>
      <line x1={0} y1={yUsual} x2={W} y2={yUsual} stroke={C.edgeStrong} strokeDasharray="3 4" />
      <polyline points={line} fill="none" stroke={C.accent} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
      {markers.map((m, i) => (
        <line key={`l-${m.t}-${i}`} x1={m.mx} y1={8} x2={m.mx} y2={PLOT_BOTTOM + 2} stroke={C.ink} strokeWidth={1} />
      ))}
      <text x={0} y={uy} fontFamily={MONO} fontSize={10} fontWeight={500} fill={C.muted} {...halo}>
        {usualText}
      </text>
      {markers.map((m, i) => (
        <text key={`t-${m.t}-${i}`} x={m.tx} y={m.ty} textAnchor={m.anchor} fontFamily={MONO} fontSize={10} fontWeight={500} fill={C.ink} {...halo}>
          {m.label}
        </text>
      ))}
      <text x={0} y={94} fontFamily={MONO} fontSize={10} fontWeight={500} fill={C.muted}>
        {clockLabel(first.t)}
      </text>
      <text x={W} y={94} textAnchor="end" fontFamily={MONO} fontSize={10} fontWeight={500} fill={C.muted}>
        now
      </text>
    </svg>
  );
}

// ---- pieces -------------------------------------------------------------------------------------

function Tile({ label, children, bg, labelColor, fg }: { label: string; children: ReactNode; bg?: string; labelColor?: string; fg?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[14px] p-3" style={{ background: bg ?? C.card, color: fg ?? C.ink }}>
      <span className="text-[12px]" style={{ color: labelColor ?? C.muted }}>
        {label}
      </span>
      {children}
    </div>
  );
}

/** Kinds whose title just restates the label ("Heavier than usual"); others add the specifics. */
const TITLE_IS_LABEL = new Set(["rush", "volume"]);

function causeDetail(c: SlowdownCause): string {
  if (TITLE_IS_LABEL.has(c.kind) || !c.title) return c.detail;
  const title = c.title.replace(/\.$/, "");
  return c.detail ? `${title}. ${c.detail}` : title;
}

function CauseBar({ c }: { c: SlowdownCause }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[15px] font-medium">{c.label}</span>
        <span className="font-num text-[14px]">{c.pct}%</span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-[5px]" style={{ background: C.line }}>
        <div className="h-2.5 rounded-[5px]" style={{ width: `${Math.max(0, Math.min(100, c.pct))}%`, background: CAUSE[c.kind]?.color ?? C.accent }} />
      </div>
      <span className="text-[12px] text-muted">{causeDetail(c)}</span>
    </div>
  );
}

/** The road's posted limit (OpenStreetMap), or plainly that we don't know it. Floats right of the title. */
function PostedLimit({ mph }: { mph: number | null }) {
  return (
    <div className="float-right mb-1 ml-3 flex flex-col items-center gap-1">
      <SpeedLimitSign mph={mph} size={40} />
      {mph === null && <span className="text-[11px] leading-none text-muted">Not known</span>}
    </div>
  );
}

function Bone({ h, w = "100%", r = 10 }: { h: number; w?: string; r?: number }) {
  return <div className="bg-card motion-safe:animate-pulse" style={{ height: h, width: w, borderRadius: r }} />;
}

const PAGE = "flex flex-col gap-[18px] px-5 pt-14 pb-28 leading-[normal] md:pt-6 md:pb-8";

// ---- screen -------------------------------------------------------------------------------------

export default function WhySlow() {
  const { screen, back, tab, slowdowns, setScene } = useApp();
  const id = screen.name === "why" ? screen.id : "";
  const stamp = slowdowns?.generated_at;

  const [detail, setDetail] = useState<SlowdownDetail | null>(null);
  const [error, setError] = useState<"missing" | "failed" | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [watching, setWatching] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  /** Bumped on every toggle: a reload that started before one must not overwrite it. */
  const toggles = useRef(0);

  // Load, and reload whenever the slowdowns refresh (new simulated minute / demo action).
  useEffect(() => {
    if (!id) return;
    let live = true;
    const seen = toggles.current;
    api
      .slowdown(id)
      .then((d) => {
        if (!live) return;
        setDetail(d);
        setError(null);
        if (!busyRef.current && toggles.current === seen) setWatching(d.watching);
      })
      .catch((e: unknown) => {
        if (!live) return;
        const msg = e instanceof Error ? e.message : "";
        setError(/unknown road|not found/i.test(msg) ? "missing" : "failed");
      });
    return () => {
      live = false;
    };
  }, [id, stamp, attempt]);

  // Map: highlight the road and fit to it (once per road, not on every refresh).
  const geomKey = detail ? JSON.stringify(detail.geometry) : "";
  useEffect(() => {
    if (!detail) return;
    setScene({ highlight: detail.geometry, fit: detail.geometry });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geomKey, setScene]);

  const toggleWatch = async () => {
    if (!detail || busyRef.current) return;
    const next = !watching;
    toggles.current += 1;
    busyRef.current = true;
    setBusy(true);
    setWatching(next);
    // Let the "it cleared" alert reach the phone's notification tray too (the shell sends it).
    try {
      if (next && typeof Notification !== "undefined" && Notification.permission === "default") {
        void Promise.resolve(Notification.requestPermission()).catch(() => {});
      }
    } catch {}
    try {
      if (next) await api.watchSlowdown(detail.id);
      else await api.unwatchSlowdown(detail.id);
    } catch {
      setWatching(!next);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  if (!detail && error) {
    const missing = error === "missing";
    return (
      <div className={PAGE}>
        <BackHeader onBack={back} label="Selected road" />
        <Card className="items-start">
          <h1 className="m-0 text-[20px] font-semibold tracking-[-0.01em]">{missing ? "We couldn't find that road." : "We couldn't load this road."}</h1>
          <p className="m-0 text-[14px] text-muted">
            {missing ? "The link may be out of date. Every slowdown in Houston is on the Causes tab." : "Check your connection and try again."}
          </p>
          <PillButton className="mt-1.5 h-11 self-stretch text-[15px]" onClick={() => (missing ? tab("causes") : setAttempt((a) => a + 1))}>
            {missing ? "See every slowdown" : "Try again"}
          </PillButton>
        </Card>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className={PAGE} aria-busy="true" aria-label="Loading road">
        <BackHeader onBack={back} label="Selected road" />
        <div className="flex flex-col gap-1.5">
          <Bone h={31} w="78%" r={8} />
          <Bone h={18} w="52%" r={6} />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Bone h={66} r={14} />
          <Bone h={66} r={14} />
          <Bone h={66} r={14} />
        </div>
        <Bone h={160} r={18} />
        <Bone h={230} r={18} />
      </div>
    );
  }

  const d = detail;
  const flowing = !d.is_slowdown || d.causes.length === 0;
  const status = d.closed ? "Closed" : LEVEL[d.level].label;
  const statusLevel: Level = d.closed ? "heavy" : d.level;
  const delayColor = d.closed ? C.heavyText : DELAY_COLOR[d.level];
  const showNotify = !flowing || watching;

  return (
    <div className={PAGE}>
      <BackHeader onBack={back} label="Selected road" />

      <div className="flow-root">
        {d.speed_limit_mph !== undefined && <PostedLimit mph={d.speed_limit_mph} />}
        <Title>{d.road}</Title>
        <span className="mt-1.5 block text-[14px] text-muted">
          {d.place} · {d.miles} mi
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Tile label="Status" bg={LEVEL[statusLevel].color} fg={LEVEL[statusLevel].fg} labelColor={STATUS_LABEL[statusLevel]}>
          <span className="text-[17px] font-semibold">{status}</span>
        </Tile>
        <Tile label="Delay">
          <span className="font-num text-[17px]" style={{ color: d.delay_min > 0 || d.closed ? delayColor : C.soft }}>
            {d.closed && d.delay_min <= 0 ? "Closed" : d.delay_min > 0 ? `+${d.delay_min} min` : d.level !== "light" ? "<1 min" : "None"}
          </span>
        </Tile>
        <Tile label="Speed">
          <span className="font-num text-[17px] whitespace-nowrap">
            {d.speed_mph}
            <span className="text-[12px] text-muted"> / {d.free_flow_mph} mph</span>
          </span>
        </Tile>
      </div>

      <Card>
        <div className="flex items-baseline justify-between">
          <h2 className="m-0 text-[17px] font-semibold">Speed, last 2 hours</h2>
          <span className="font-num text-[12px] text-muted">mph</span>
        </div>
        <SpeedChart h={d.history} />
      </Card>

      <Card style={{ gap: 14 }}>
        <div className="flex items-baseline justify-between">
          <h2 className="m-0 text-[17px] font-semibold">What&apos;s causing it</h2>
          {!flowing && <span className="text-[12px] text-muted">Share of delay</span>}
        </div>
        {flowing ? (
          <div className="flex flex-col gap-1">
            <span className="text-[15px] font-medium">Traffic is moving normally here.</span>
            <span className="text-[12px] text-muted">
              {d.speed_mph} mph now; the usual for this time is {d.usual_mph} mph.
            </span>
          </div>
        ) : (
          d.causes.map((c, i) => <CauseBar key={`${c.kind}-${i}`} c={c} />)
        )}
      </Card>

      {showNotify && (
        <PillButton variant={watching ? "outline" : "primary"} aria-busy={busy} onClick={toggleWatch}>
          {watching ? "We’ll tell you when it clears" : "Notify me when it clears"}
        </PillButton>
      )}
      <span className="text-center text-[12px] text-muted" style={{ marginTop: showNotify ? -8 : 0 }}>
        From road sensors, incident reports and roadwork feeds
      </span>
    </div>
  );
}
