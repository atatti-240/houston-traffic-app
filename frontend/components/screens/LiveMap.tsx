"use client";

/** Live map: "Houston right now". Phone: overlays + bottom sheet on the full-screen map (design
 * "Live map"). Desktop: the same content as a side panel; the controls sit on the map. */

import { useEffect, useMemo, useRef, useState } from "react";

import { useApp } from "@/components/app/AppContext";
import { Legend, LayersButton, LiveCamsButton, ZoomButtons } from "@/components/app/MapChrome";
import ReportButton from "@/components/reports/ReportButton";
import { CauseChip, CauseDot, Icon, LevelDot, Logo, RoundButton, ago } from "@/components/ui";
import { fmtTime, parseSim, toSimIso } from "@/lib/format";
import { CAUSE, CAUSE_ORDER, C, ICON, SHADOW, type CauseKind } from "@/lib/theme";
import type { Slowdown } from "@/lib/types";

const LATER = [
  { label: "Now", min: 0 },
  { label: "+30 min", min: 30 },
  { label: "+1 h", min: 60 },
  { label: "+2 h", min: 120 },
];

function SearchBar({ onOpen, className = "" }: { onOpen: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`flex h-12 min-w-0 cursor-pointer items-center gap-2.5 rounded-3xl bg-float px-4 text-left text-[15px] text-muted ${className}`}
      style={{ boxShadow: SHADOW[1] }}
    >
      <Icon d={ICON.search} size={18} color={C.muted} />
      Search Houston
    </button>
  );
}

function useSheetData() {
  const { slowdowns, causeFilter, setCauseFilter, clock, mapTime, setMapTime, backendDown } = useApp();
  const highlighted = useMemo(() => (slowdowns?.items ?? []).filter((s) => s.highlight), [slowdowns]);
  // The active filter keeps its chip after its last slowdown clears, so it can still be seen and turned off.
  const kinds = useMemo(() => {
    const present = new Set(highlighted.map((s) => s.kind));
    const ordered = CAUSE_ORDER.filter((k) => present.has(k) || k === causeFilter);
    return ordered.length ? ordered : (CAUSE_ORDER.slice(0, 7) as CauseKind[]);
  }, [highlighted, causeFilter]);
  const later = (min: number) => {
    if (!clock || min === 0) return setMapTime(null);
    const t = parseSim(clock.now);
    t.setMinutes(t.getMinutes() + min);
    setMapTime(toSimIso(t));
  };
  const laterSel = mapTime && clock ? Math.round((parseSim(mapTime).getTime() - parseSim(clock.now).getTime()) / 60000) : 0;
  return { slowdowns, highlighted, kinds, causeFilter, setCauseFilter, clock, mapTime, later, laterSel, backendDown };
}

function TimeChips({ later, laterSel }: { later: (m: number) => void; laterSel: number }) {
  return (
    <div className="flex gap-1.5" role="group" aria-label="Show traffic at">
      {LATER.map((o) => {
        const on = Math.abs(laterSel - o.min) < 5;
        return (
          <button
            key={o.label}
            type="button"
            onClick={() => later(o.min)}
            aria-pressed={on}
            className="h-7 cursor-pointer rounded-[14px] px-2.5 text-[12px] font-medium"
            style={on ? { background: C.sel, color: C.onSel } : { background: C.card, color: C.soft }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function SlowdownRow({ s }: { s: Slowdown }) {
  const { select, focus, go, isDesktop } = useApp();
  return (
    <button
      type="button"
      onClick={() => {
        if (isDesktop) {
          select(s.id);
          focus({ lat: s.lat, lng: s.lng, zoom: 13 });
        } else go({ name: "why", id: s.id });
      }}
      className="flex w-full cursor-pointer items-center gap-3 rounded-[14px] bg-card px-3 py-2.5 text-left hover:bg-card-hi"
    >
      <CauseDot kind={(s.kind ?? "rush") as CauseKind} size={32} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[15px] font-semibold text-ink">{s.title}</span>
        <span className="truncate text-[12px] text-muted">{s.road}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <LevelDot level={s.level} />
        <span className="font-num text-[13px] text-ink">+{s.delay_min}m</span>
      </span>
    </button>
  );
}

function Summary({ compact }: { compact?: boolean }) {
  const { slowdowns, highlighted, kinds, causeFilter, setCauseFilter, clock, mapTime, later, laterSel, backendDown } = useSheetData();
  const count = slowdowns?.count ?? 0;
  return (
    <>
      <div className="flex items-baseline justify-between">
        <h1 className="m-0 text-[21px] font-bold tracking-[-0.01em] text-ink">{mapTime ? `Houston at ${fmtTime(mapTime)}` : "Houston right now"}</h1>
        <span className="font-num text-[12px] text-muted">
          {mapTime ? "Predicted" : slowdowns ? `Updated ${ago(slowdowns.generated_at, clock?.now) || "just now"}` : ""}
        </span>
      </div>
      <span className="text-[13px] text-muted">
        {mapTime
          ? "Predicted traffic from 8 weeks of history. Live causes show for now only."
          : !slowdowns
            ? backendDown
              ? "Can't reach live traffic right now. We'll keep trying."
              : "Checking Houston's roads…"
            : `${count} slowdown${count === 1 ? "" : "s"}, ${highlighted.length} worth knowing about. Hover or tap an icon to see the cause.`}
      </span>
      <div className={`no-scrollbar flex gap-2 pb-0.5 ${compact ? "overflow-x-auto" : "flex-wrap"}`}>
        {kinds.map((k) => (
          <CauseChip
            key={k}
            kind={k}
            label={CAUSE[k].label}
            active={causeFilter === k}
            onClick={() => setCauseFilter(causeFilter === k ? null : k)}
          />
        ))}
      </div>
      {!compact && <TimeChips later={later} laterSel={laterSel} />}
    </>
  );
}

function SlowdownList() {
  const { highlighted, causeFilter } = useSheetData();
  const { tab } = useApp();
  const shown = highlighted.filter((s) => !causeFilter || s.kind === causeFilter);
  return (
    <div className="flex flex-col gap-2">
      {shown.map((s) => (
        <SlowdownRow key={s.id} s={s} />
      ))}
      <button type="button" onClick={() => tab("causes")} className="mt-1 cursor-pointer text-left text-[14px] font-medium text-accent">
        See every slowdown and its causes →
      </button>
    </div>
  );
}

export default function LiveMap() {
  const { isDesktop, go } = useApp();
  const [expanded, setExpanded] = useState(false);
  const sheet = useSheetData();
  // The sheet's height (it grows when expanded, up to 70dvh): the floating buttons sit just above it.
  const sheetRef = useRef<HTMLElement>(null);
  const [sheetH, setSheetH] = useState(156);
  useEffect(() => {
    const el = sheetRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSheetH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [isDesktop]);

  if (isDesktop) {
    return (
      <div className="flex flex-col gap-4 px-5 pt-6 pb-6">
        <div className="flex items-center justify-between">
          <a href="/" aria-label="About BlindSpot" className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            <Logo size={18} />
          </a>
        </div>
        <SearchBar onOpen={() => go({ name: "where" })} />
        <div className="flex flex-col gap-2">
          <Summary />
        </div>
        <SlowdownList />
      </div>
    );
  }

  return (
    <>
      <div className="pointer-events-auto absolute top-3 left-4 z-[900]">
        <a href="/" aria-label="About BlindSpot" className="block rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          <Logo size={18} pill />
        </a>
      </div>
      {/* Above the legend and zoom buttons: the layers menu opens down over them */}
      <div className="pointer-events-auto absolute top-14 right-4 left-4 z-[910] flex items-center gap-2.5">
        <SearchBar onOpen={() => go({ name: "where" })} className="flex-1" />
        <LayersButton />
      </div>
      <div className="pointer-events-auto absolute top-[116px] left-4 z-[900] max-w-[calc(100%-86px)]">
        <Legend />
      </div>
      <div className="pointer-events-auto absolute top-[116px] right-4 z-[900]">
        <ZoomButtons />
      </div>
      {/* Expanded, the sheet leaves little map above it (the zoom buttons are there), so it rides the sheet's top edge. The
          expanded sheet's top stays 189px down (273px = that + the 84px nav): below Zoom in (ends at 161px) plus this button's top half. */}
      <div className={`pointer-events-auto absolute right-4 ${expanded ? "z-[960]" : "z-[900]"}`} style={{ bottom: 84 + sheetH + (expanded ? -24 : 16) }}>
        <LiveCamsButton />
      </div>
      {!expanded && (
        <div className="pointer-events-auto absolute left-4 z-[900]" style={{ bottom: 84 + sheetH + 16 }}>
          <ReportButton />
        </div>
      )}
      <section
        ref={sheetRef}
        aria-label="Houston right now"
        className="pointer-events-auto absolute right-0 left-0 z-[950] flex flex-col gap-2 rounded-t-3xl bg-bg px-5 pt-2.5 pb-3.5"
        style={{
          bottom: 84,
          boxShadow: SHADOW.up,
          maxHeight: expanded ? "min(70dvh, calc(100dvh - 273px))" : 156,
          transition: "max-height 200ms ease",
        }}
      >
        <button
          type="button"
          aria-label={expanded ? "Collapse" : "Show all slowdowns"}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="flex h-4 w-full cursor-pointer items-center justify-center"
        >
          <span className="h-1 w-10 rounded-sm" style={{ background: C.edgeStrong }} />
        </button>
        <Summary compact={!expanded} />
        {expanded && (
          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
            <SlowdownList />
          </div>
        )}
      </section>
      {!expanded && sheet.mapTime && (
        <div className="pointer-events-auto absolute right-4 z-[900]" style={{ bottom: 84 + sheetH + 72 }}>
          <RoundButton label="Back to now" onClick={() => sheet.later(0)}>
            <Icon d={ICON.clock} size={20} />
          </RoundButton>
        </div>
      )}
    </>
  );
}
