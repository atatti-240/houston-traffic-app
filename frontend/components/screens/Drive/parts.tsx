"use client";

/** Driving view pieces: the next-turn banner, lane arrows, the speed limit sign, status lines and round buttons.
 * All in theme colors (light and dark); floating pieces use the theme's surfaces and shadows like the other map controls. */

import type { ReactNode } from "react";

import { Icon } from "@/components/ui";
import { SpeedLimitSign } from "@/components/ui/SpeedLimitSign";
import { fmtDistance, laneIcons, lanesText, maneuverIcon } from "@/lib/directions";
import { C, ICON, LEVEL, SHADOW } from "@/lib/theme";
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
              <path key={d} d={d} stroke={lane.valid ? C.onInk : C.muted} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
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
    <div className="flex flex-col overflow-hidden rounded-[22px] border border-edge" style={{ background: C.float, boxShadow: SHADOW[2] }}>
      <div className="flex items-start gap-3.5 p-4">
        <span
          className="flex h-[64px] w-[64px] shrink-0 items-center justify-center rounded-[18px]"
          style={arrive ? { background: LEVEL.heavy.bg, color: LEVEL.heavy.fg } : { background: C.accent, color: C.onAccent }}
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
export function PlainBanner({
  icon,
  title,
  sub,
  tone,
}: {
  icon: string;
  title: ReactNode;
  sub?: ReactNode;
  /** The icon tile's fill and icon color, e.g. LEVEL.heavy (a pill pair that reads in both themes) */
  tone?: { bg: string; fg: string };
}) {
  return (
    <div className="flex items-center gap-3.5 rounded-[22px] border border-edge p-4" style={{ background: C.float, boxShadow: SHADOW[2] }}>
      <span className="flex h-[56px] w-[56px] shrink-0 items-center justify-center rounded-[16px]" style={{ background: tone?.bg ?? C.card, color: tone?.fg ?? C.ink }} aria-hidden="true">
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

/** A US speed limit sign (the app's sign: black on white in both themes), lifted off the map. Only drawn when the
 * limit is known. */
export function SpeedLimit({ mph }: { mph: number }) {
  return (
    <div className="flex rounded-[8px]" style={{ boxShadow: SHADOW[2] }} data-testid="speed-limit">
      <SpeedLimitSign mph={mph} size={64} />
    </div>
  );
}

/** One status line under the banner (a hazard ahead, re-planning, location). `tone`: the icon's color, one that reads on
 * a surface in both themes (C.*Text, C.accent, C.muted). `live`: announced by screen readers when it changes (keep its
 * text steady: a distance counting down would be read out every second). */
export function Note({ icon, tone, children, testId, live = false }: { icon: string; tone: string; children: ReactNode; testId?: string; live?: boolean }) {
  return (
    <div
      className="flex items-start gap-2.5 rounded-[14px] border border-edge px-3.5 py-2.5 text-[14px] leading-snug"
      style={{ background: C.float, color: C.ink, boxShadow: SHADOW[1] }}
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
      className="flex h-12 w-12 shrink-0 cursor-pointer items-center justify-center rounded-full disabled:cursor-default disabled:opacity-50"
      style={{ background: pressed ? C.sel : C.float, color: pressed ? C.onSel : C.ink, boxShadow: SHADOW[1] }}
    >
      {children}
    </button>
  );
}
