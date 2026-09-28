"use client";

/** Drive / Walk / Bike / Transit tabs at the top of the Trip screen. The tab is part of the screen
 * (?travel=walk), so it has its own history entry and survives back / forward and reloads. */

import type { KeyboardEvent } from "react";

import { useApp } from "@/components/app/AppContext";
import { Icon } from "@/components/ui";
import { MODE_ICON, type Travel } from "@/lib/modes";
import { C } from "@/lib/theme";

type Tab = "drive" | Travel;

const TABS: { tab: Tab; label: string; icon: string }[] = [
  { tab: "drive", label: "Drive", icon: MODE_ICON.drive },
  { tab: "walk", label: "Walk", icon: MODE_ICON.walk },
  { tab: "bike", label: "Bike", icon: MODE_ICON.bike },
  { tab: "transit", label: "Transit", icon: MODE_ICON.transit },
];

/** `drive`: the Drive tab's current choices, carried along so coming back to Drive keeps them. */
export default function TravelTabs({ drive }: { drive?: { arriveBy?: string; safety?: number } }) {
  const { screen, go } = useApp();
  if (screen.name !== "trip") return null;
  const current: Tab = screen.travel ?? "drive";

  const pick = (t: Tab) => {
    if (t === current) return;
    // Leaving Drive: keep its time and slider (the slider only when it moved, to keep the link short).
    const keep =
      current === "drive" && drive ? { arriveBy: drive.arriveBy, safety: drive.safety === (screen.safety ?? 0) ? screen.safety : drive.safety } : {};
    go({ ...screen, ...keep, travel: t === "drive" ? undefined : t });
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const i = TABS.findIndex((t) => t.tab === current);
    pick(TABS[(i + d + TABS.length) % TABS.length].tab);
    // Drive and the other tabs are different screens: focus the picked tab in whichever is showing now.
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-travel-tabs] [aria-selected="true"]')?.focus());
  };

  return (
    <div role="tablist" aria-label="How to get there" data-travel-tabs onKeyDown={onKey} className="grid grid-cols-4 gap-1.5">
      {TABS.map((t) => {
        const on = t.tab === current;
        return (
          <button
            key={t.tab}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            onClick={() => pick(t.tab)}
            className="flex h-10 min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-[20px] text-[13px] font-semibold"
            style={on ? { background: C.accent, color: C.onAccent } : { background: C.card, color: C.soft }}
          >
            <Icon d={t.icon} size={17} className="shrink-0" />
            <span className="truncate">{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}
