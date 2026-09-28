"use client";

/** Trip: turn-by-turn steps for the picked route (collapsed until asked for), with lane arrows where the map
 * has turn lanes. Road names are OpenStreetMap text, rendered as text. */

import { useId, useState } from "react";

import { Icon } from "@/components/ui";
import { fmtDistance, laneIcons, lanesText, maneuverIcon } from "@/lib/directions";
import { C, ICON } from "@/lib/theme";
import type { RouteDirections, RouteStep } from "@/lib/types";

function Lanes({ lanes }: { lanes: NonNullable<RouteStep["lanes"]> }) {
  return (
    <span className="flex items-center gap-1" role="img" aria-label={lanesText(lanes)}>
      {lanes.map((lane, i) => (
        <span
          key={i}
          className="flex h-[26px] w-[22px] items-center justify-center rounded-[6px]"
          style={lane.valid ? { background: C.edgeStrong } : { border: `1px solid ${C.line}` }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            {laneIcons(lane.indications).map((d) => (
              <path
                key={d}
                d={d}
                stroke={lane.valid ? C.ink : C.muted}
                strokeOpacity={lane.valid ? 1 : 0.55}
                strokeWidth={2.4}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
          </svg>
        </span>
      ))}
    </span>
  );
}

function Step({ step, last }: { step: RouteStep; last: boolean }) {
  const arrive = step.maneuver.type === "arrive";
  return (
    <li className="flex gap-3">
      <span className="flex flex-col items-center" aria-hidden="true">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
          style={{ background: arrive ? C.heavy : C.cardHi, color: arrive ? C.onDot : C.ink }}
        >
          <Icon d={maneuverIcon(step)} size={18} />
        </span>
        {!last && <span className="w-0.5 flex-1 bg-line" />}
      </span>
      <div className={`flex min-w-0 flex-1 flex-col gap-1 pt-1 ${last ? "" : "pb-3"}`}>
        <span className="text-[14px] leading-snug text-ink">{step.instruction}</span>
        {(step.distance_m >= 1 || step.lanes) && (
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            {step.distance_m >= 1 && <span className="font-num text-[12px] text-muted">{fmtDistance(step.distance_m)}</span>}
            {step.lanes && <Lanes lanes={step.lanes} />}
          </span>
        )}
      </div>
    </li>
  );
}

export default function Steps({ directions }: { directions: RouteDirections | undefined }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (!directions) return null;
  const { status, steps, note } = directions;

  if (status === "pending")
    return (
      <div className="flex items-center gap-3 rounded-[14px] bg-card px-4 py-3" aria-busy="true">
        <span className="h-4 w-4 shrink-0 animate-pulse rounded-full bg-card-hi" />
        <span className="text-[14px] text-muted">Getting turn-by-turn directions…</span>
      </div>
    );
  if (!steps.length)
    return (
      <p className="m-0 flex gap-2.5 rounded-[14px] bg-card px-4 py-3 text-[13px] leading-snug text-muted" role="status">
        <Icon d={ICON.map} size={16} className="mt-px shrink-0" />
        <span>{note ?? "Turn-by-turn directions aren't available for this route."}</span>
      </p>
    );

  const total = directions.distance_m ?? steps.reduce((a, s) => a + s.distance_m, 0);
  const withLanes = steps.filter((s) => s.lanes).length;
  return (
    <section className="flex flex-col rounded-[14px] bg-card">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen(!open)}
        className="flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[14px] font-semibold text-ink">Turn-by-turn steps</span>
          <span className="font-num truncate text-[12px] text-muted">
            {steps.length} steps · {fmtDistance(total)}
            {withLanes ? ` · lane arrows at ${withLanes}` : ""}
          </span>
        </span>
        <Icon d={ICON.chevron} size={18} color={C.muted} className="shrink-0 transition-transform" style={{ transform: `rotate(${open ? 90 : 0}deg)` }} />
      </button>
      {open && (
        <div id={listId} className="flex flex-col gap-3 border-t border-line px-4 pt-3 pb-4">
          {note && <span className="text-[12px] leading-snug text-muted">{note}</span>}
          <ol className="m-0 flex list-none flex-col p-0">
            {steps.map((s, i) => (
              <Step key={i} step={s} last={i === steps.length - 1} />
            ))}
          </ol>
          <span className="text-[11px] text-muted">Directions: OSRM, map data © OpenStreetMap contributors</span>
        </div>
      )}
    </section>
  );
}
