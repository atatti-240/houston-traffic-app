"use client";

/** Trip screen: a warning when the route crosses a flooded road (driver reports or a flooding
 * incident), the heads-up reports on it (police, potholes: they don't change routes, so the route's
 * reasons don't name them), and on a phone the Report button over the map, just above the Trip sheet. */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useApp } from "@/components/app/AppContext";
import ReportButton from "@/components/reports/ReportButton";
import { Icon } from "@/components/ui";
import { REPORT_KINDS, selectReport, useReports, type DriverReport } from "@/lib/reports";
import { C } from "@/lib/theme";
import type { PlanResult, Recommendation, Route } from "@/lib/types";

/** What the Trip screen shows: one route, a recommendation, or a multi-stop plan. */
export type TripResultLike = { best: Route } | { rec: Recommendation } | { plan: PlanResult };

interface Flood {
  road: string;
  /** "Reported by drivers, 12 min ago, 3 still there" */
  said?: string;
}

/** Flooded roads on the route shown: flooding reports on its roads, flooding incidents on them,
 * and (multi-stop plans) flooding hazards on its legs. */
export function floodsOn(result: TripResultLike | null, reports: DriverReport[]): Flood[] {
  if (!result) return [];
  const out: Flood[] = [];
  const route = "best" in result ? result.best : "rec" in result ? result.rec.route : null;
  if (route) {
    for (const s of route.segments) {
      // Each flooding report on this road (a road counts only its worst incident), else its flooding incident.
      const said = reports.filter((r) => r.kind === "flooding" && (r.segment_id === s.id || r.also_on === s.id));
      for (const r of said) out.push({ road: (r.segment_id === s.id && r.road) || s.name, said: r.provenance });
      if (!said.length && (s.incident?.kind === "flooding" || s.closure?.kind === "flooding")) out.push({ road: s.name });
    }
  } else if ("plan" in result) {
    for (const leg of result.plan.legs)
      for (const h of leg.hazards)
        if (h.type === "incident" && h.kind === "flooding") out.push({ road: typeof h.road === "string" ? h.road : h.name });
  }
  // One line per road.
  return out.filter((f, i) => out.findIndex((g) => g.road === f.road) === i);
}

/** Police and pothole reports on the route shown (one route, not a multi-stop plan). */
export function headsUpOn(result: TripResultLike | null, reports: DriverReport[]): DriverReport[] {
  const route = result && ("best" in result ? result.best : "rec" in result ? result.rec.route : null);
  if (!route) return [];
  const ids = new Set(route.segments.map((s) => s.id));
  return reports.filter((r) => (r.kind === "police" || r.kind === "pothole") && r.segment_id && ids.has(r.segment_id));
}

function HeadsUp({ reports }: { reports: DriverReport[] }) {
  const { focus } = useApp();
  return (
    <div className="flex flex-col gap-1.5 rounded-[14px] bg-card px-3.5 py-3">
      <span className="text-[13px] font-semibold tracking-[0.08em] text-muted uppercase">Reported on your route</span>
      {reports.slice(0, 3).map((r) => {
        const k = REPORT_KINDS[r.kind];
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => {
              focus({ lat: r.lat, lng: r.lng, zoom: 14 });
              setTimeout(() => selectReport(r.id), 300);
            }}
            className="flex w-full cursor-pointer items-start gap-2.5 rounded-lg py-1 text-left"
          >
            <span className="mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-full" style={{ background: k.color }}>
              <Icon d={k.icon} size={14} color={k.ink} width={2.3} />
            </span>
            <span className="flex min-w-0 flex-col text-[13px] leading-snug">
              <span className="font-medium text-ink">
                {k.label} · {r.road}
              </span>
              <span className="text-muted">{r.provenance}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function FloodWarning({ floods }: { floods: Flood[] }) {
  return (
    <div className="flex items-start gap-3 rounded-[14px] px-3.5 py-3" style={{ background: "rgba(255,77,77,0.12)" }} role="status">
      <span className="mt-px flex h-8 w-8 shrink-0 items-center justify-center rounded-full" style={{ background: REPORT_KINDS.flooding.color }}>
        <Icon d={REPORT_KINDS.flooding.icon} size={18} color={REPORT_KINDS.flooding.ink} width={2.3} />
      </span>
      <div className="flex min-w-0 flex-col gap-1 text-[13px] leading-snug">
        <span className="text-[15px] font-semibold" style={{ color: C.heavyText }}>
          Flooding on your route
        </span>
        {floods.map((f) => (
          <span key={f.road} className="text-soft">
            <span className="font-medium text-ink">{f.road}</span>
            {f.said ? `: ${f.said}` : ": water reported on the road"}
          </span>
        ))}
        <span className="text-soft">Turn around, don&apos;t drown. Never drive into water on the road.</span>
      </div>
    </div>
  );
}

/** Phone: the Report button floats over the map just above the Trip sheet (the sheet that holds this screen). */
function FloatingReportButton() {
  const anchor = useRef<HTMLSpanElement>(null);
  const [bottom, setBottom] = useState<number | null>(null);
  useEffect(() => {
    let panel = anchor.current?.parentElement ?? null;
    while (panel && !["absolute", "fixed"].includes(getComputedStyle(panel).position)) panel = panel.parentElement;
    if (!panel) return;
    const sheet = panel;
    const measure = () => setBottom(Math.max(0, Math.round(window.innerHeight - sheet.getBoundingClientRect().top)) + 12);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(sheet);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  return (
    <>
      <span ref={anchor} hidden />
      {bottom !== null &&
        createPortal(
          <div className="fixed right-4 z-[1001]" style={{ bottom }}>
            <ReportButton />
          </div>,
          document.body,
        )}
    </>
  );
}

export default function TripReports({ result }: { result: TripResultLike | null }) {
  const { isDesktop } = useApp();
  const { items } = useReports();
  const floods = useMemo(() => floodsOn(result, items), [result, items]);
  const headsUp = useMemo(() => headsUpOn(result, items), [result, items]);
  return (
    <>
      {floods.length > 0 && <FloodWarning floods={floods} />}
      {headsUp.length > 0 && <HeadsUp reports={headsUp} />}
      {/* Desktop: the map's own Report button is next to this panel */}
      {!isDesktop && <FloatingReportButton />}
    </>
  );
}
