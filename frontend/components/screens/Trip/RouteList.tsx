"use client";

/** Trip: the routes to pick from (like the lines on the map: the picked one solid, the others dashed), and how the
 * picked one compares with them ("4 min faster than via I-610 and skips the train crossing at Cullen Blvd"). */

import type { KeyboardEvent } from "react";

import { CauseDot, Icon } from "@/components/ui";
import { compareRoutes } from "@/lib/directions";
import { fmtTime } from "@/lib/format";
import { CAUSE, C, ICON } from "@/lib/theme";
import type { Route } from "@/lib/types";

const minutes = (r: Route) => Math.max(1, Math.round(r.total_min));

function Swatch({ on }: { on: boolean }) {
  return (
    <span
      className="h-0 w-5 shrink-0 border-t-[3px]"
      style={{ borderColor: on ? C.accent : C.muted, borderStyle: on ? "solid" : "dashed" }}
      aria-hidden="true"
    />
  );
}

export function RouteList({
  routes,
  selected,
  onPick,
  pendingTimes,
  roughTimes,
}: {
  routes: Route[];
  selected: Route;
  onPick: (id: string) => void;
  pendingTimes: (r: Route) => boolean;
  roughTimes: (r: Route) => boolean;
}) {
  // Only door-to-door times are compared ("Fastest", "+4 min")
  const ready = routes.filter((r) => !roughTimes(r));
  const fastest = ready.length ? Math.min(...ready.map(minutes)) : null;
  const keys = (e: KeyboardEvent<HTMLElement>) => {
    const d = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const i = routes.indexOf(selected);
    const next = routes[(i + d + routes.length) % routes.length];
    if (next?.id) onPick(next.id);
    const group = e.currentTarget;
    requestAnimationFrame(() => group.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
  };
  return (
    <div role="radiogroup" aria-label="Routes" onKeyDown={keys} className="flex flex-col gap-1.5">
      {routes.map((r) => {
        const on = r === selected;
        const pending = pendingTimes(r);
        // What stands out: a crash, a train, a closure... before plain traffic
        const cause = r.delay_causes?.find((c) => c.kind !== "rush" && c.minutes >= 2) ?? r.delay_causes?.[0];
        const rough = roughTimes(r);
        const more = fastest !== null && !rough ? minutes(r) - fastest : 0;
        return (
          <button
            key={r.id ?? r.summary}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => r.id && onPick(r.id)}
            className="flex w-full cursor-pointer items-center gap-3 rounded-[14px] px-3.5 py-2.5 text-left"
            style={{ background: on ? C.cardHi : C.card, boxShadow: on ? `inset 0 0 0 1.5px ${C.accent}` : undefined }}
          >
            <Swatch on={on} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="font-num shrink-0 text-[16px] text-ink" aria-busy={pending}>
                  {pending ? "… min" : `${minutes(r)} min`}
                </span>
                <span className="min-w-0 truncate text-[14px] font-medium text-soft">{r.label ?? r.summary}</span>
              </span>
              <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted">
                {cause ? (
                  <>
                    <CauseDot kind={cause.kind} size={16} />
                    <span className="min-w-0 truncate" title={cause.label}>
                      {cause.kind === "train" ? cause.label : CAUSE[cause.kind].label}{" "}
                      <span className="font-num">+{cause.minutes} min</span>
                    </span>
                  </>
                ) : (
                  <span className="min-w-0 truncate">{pending ? "Getting directions…" : "No big delays"}</span>
                )}
              </span>
            </span>
            {!pending && (
              <span className="flex shrink-0 flex-col items-end gap-0.5">
                {rough ? (
                  <span className="text-[12px] text-muted" title="Times cover the main roads only">
                    Main roads only
                  </span>
                ) : (
                  fastest !== null &&
                  routes.length > 1 && (
                    <span className="font-num text-[12px]" style={{ color: more ? C.soft : C.light }}>
                      {more ? `+${more} min` : "Fastest"}
                    </span>
                  )
                )}
                <span className="font-num text-[12px] text-muted">
                  <span className="sr-only">Arrive </span>
                  {fmtTime(r.arrive_at)}
                </span>
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** "Why this way" vs. the other routes. */
export function Comparisons({ route, others, roughTimes }: { route: Route; others: Route[]; roughTimes: (r: Route) => boolean }) {
  const lines = compareRoutes(route, others, roughTimes);
  if (!lines.length) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {lines.map((line) => (
        <li key={line} className="flex gap-2.5 text-[14px] leading-snug text-soft">
          <Icon d={ICON.map} size={16} color={C.accent} className="mt-0.5 shrink-0" />
          <span className="min-w-0">{line}</span>
        </li>
      ))}
    </ul>
  );
}
