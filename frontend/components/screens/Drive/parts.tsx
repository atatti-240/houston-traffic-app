"use client";

/** Driving view pieces: the next-turn banner, lane arrows, the speed limit sign, status lines and round buttons. */

import type { ReactNode } from "react";

import { Icon } from "@/components/ui";
import { fmtDistance, laneIcons, lanesText, maneuverIcon } from "@/lib/directions";
import { C, ICON } from "@/lib/theme";
import type { RouteStep } from "@/lib/types";

export const DRIVE_ICON = {
  voice: "M4 9h4l5-4v14l-5-4H4zM16.5 9.5a3.5 3.5 0 0 1 0 5M19 7a7 7 0 0 1 0 10",
  voiceOff: "M4 9h4l5-4v14l-5-4H4zM17 9.5l5 5M22 9.5l-5 5",
  pin: ICON.pin,
} as const;

function Lanes({ lanes }: { lanes: NonNullable<RouteStep["lanes"]> }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5" role="img" aria-label={lanesText(lanes)}>
      {lanes.map((lane, i) => (
        <span
          key={i}
          className="flex h-[38px] w-[32px] items-center justify-center rounded-[8px]"
          style={lane.valid ? { background: C.ink } : { border: `1.5px solid ${C.edgeStrong}` }}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            {laneIcons(lane.indications).map((d) => (
              <path key={d} d={d} stroke={lane.valid ? C.onAccent : C.muted} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
            ))}
          </svg>
        </span>
      ))}
    </span>
  );
}

/** The next turn, big: arrow, live distance, what to do and the road, lanes when the map has them. `live`: a screen
 * reader announces each new instruction (off while the voice says it anyway). */
export function TurnBanner({
  step,
  distance,
  then,
  live = true,
}: {
  step: RouteStep;
  distance: number;
  /** The turn right after it, when it comes quickly */
  then: RouteStep | null;
  live?: boolean;
}) {
  const arrive = step.maneuver.type === "arrive";
  const showRoad = step.road && !step.instruction.includes(step.road);
  return (
    <div className="flex flex-col overflow-hidden rounded-[22px] border border-edge" style={{ background: C.cardHi, boxShadow: "0 6px 24px rgba(0,0,0,0.55)" }}>
      <div className="flex items-start gap-3.5 p-4">
        <span
          className="flex h-[64px] w-[64px] shrink-0 items-center justify-center rounded-[18px]"
          style={{ background: arrive ? C.heavy : C.accent, color: C.onAccent }}
          aria-hidden="true"
        >
          <Icon d={maneuverIcon(step)} size={40} width={2.4} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="font-num text-[34px] leading-none tracking-[-0.02em] text-ink" data-testid="drive-distance">
            {fmtDistance(distance)}
          </span>
          <span className="text-[19px] leading-snug font-semibold text-ink" aria-live={live ? "polite" : "off"} data-testid="drive-instruction">
            {step.instruction}
          </span>
          {showRoad && <span className="truncate text-[14px] text-soft">{step.road}</span>}
        </div>
      </div>
      {step.lanes && (
        <div className="flex items-center gap-2 border-t border-edge px-4 py-2.5" data-testid="drive-lanes">
          <Lanes lanes={step.lanes} />
        </div>
      )}
      {then && (
        <div className="flex items-center gap-2 border-t border-edge px-4 py-2 text-[14px] text-soft" style={{ background: C.card }}>
          <span className="text-muted">Then</span>
          <Icon d={maneuverIcon(then)} size={18} color={C.ink} />
          <span className="min-w-0 truncate">{then.instruction}</span>
        </div>
      )}
    </div>
  );
}

/** Banner for everything that isn't a turn: arrived, no turn-by-turn, getting the route. */
export function PlainBanner({ icon, title, sub, tone }: { icon: string; title: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div className="flex items-center gap-3.5 rounded-[22px] border border-edge p-4" style={{ background: C.cardHi, boxShadow: "0 6px 24px rgba(0,0,0,0.55)" }}>
      <span className="flex h-[56px] w-[56px] shrink-0 items-center justify-center rounded-[16px]" style={{ background: tone ?? C.card, color: tone ? C.onAccent : C.ink }} aria-hidden="true">
        <Icon d={icon} size={32} width={2.2} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {/* Only the title is announced: the rest (a distance) changes every second */}
        <span className="text-[21px] leading-tight font-semibold text-ink" aria-live="polite">
          {title}
        </span>
        {sub && <span className="text-[14px] leading-snug text-soft">{sub}</span>}
      </div>
    </div>
  );
}

/** A US speed limit sign. Only drawn when the limit is known. */
export function SpeedLimit({ mph }: { mph: number }) {
  return (
    <div
      className="flex w-[64px] flex-col items-center rounded-[10px] border-[3px] px-1 pt-1 pb-1.5 leading-none"
      style={{ background: "#FFFFFF", borderColor: "#11141A", color: "#11141A", boxShadow: "0 2px 12px rgba(0,0,0,0.5)" }}
      role="img"
      aria-label={`Speed limit ${mph}`}
      data-testid="speed-limit"
    >
      <span className="text-[10px] font-bold tracking-[0.04em]">SPEED</span>
      <span className="text-[10px] font-bold tracking-[0.04em]">LIMIT</span>
      <span className="mt-0.5 text-[28px] font-bold tracking-[-0.03em]">{mph}</span>
    </div>
  );
}

/** One status line under the banner (a hazard ahead, re-planning, location). `live`: announced by screen readers
 * when it changes (keep its text steady: a distance counting down would be read out every second). */
export function Note({ icon, tone, children, testId, live = false }: { icon: string; tone: string; children: ReactNode; testId?: string; live?: boolean }) {
  return (
    <div
      className="flex items-start gap-2.5 rounded-[14px] border border-edge px-3.5 py-2.5 text-[14px] leading-snug"
      style={{ background: "rgba(30,34,43,0.96)", color: C.ink, boxShadow: "0 2px 12px rgba(0,0,0,0.45)" }}
      role={live ? "status" : undefined}
      data-testid={testId}
    >
      <Icon d={icon} size={18} color={tone} className="mt-px shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** A button inside a note's text, still big enough to tap while driving. */
export function InlineAction({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="-my-2.5 inline-flex h-11 cursor-pointer items-center px-1 align-middle font-medium text-accent">
      {children}
    </button>
  );
}

/** Round floating button (mute, recenter). */
export function FloatButton({
  label,
  title,
  onClick,
  children,
  pressed,
  disabled,
}: {
  label: string;
  /** The tooltip, when it should say more than the label */
  title?: string;
  onClick: () => void;
  children: ReactNode;
  pressed?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className="flex h-12 w-12 shrink-0 cursor-pointer items-center justify-center rounded-full border border-edge text-ink disabled:cursor-default disabled:opacity-50"
      style={{ background: pressed ? C.cardHi : C.card, boxShadow: "0 2px 12px rgba(0,0,0,0.45)" }}
    >
      {children}
    </button>
  );
}
