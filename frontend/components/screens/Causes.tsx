"use client";

/** Causes tab: every slowdown in Houston and what's causing it. Where the delay comes from (share
 * by cause), cause chips that filter the list, then the unusual slowdowns (crash, event, train,
 * closure, weather, construction, heavier than usual) and the ordinary rush-hour ones.
 * Tap a road for "Why it's slow". */

import { useMemo, useState, type ReactNode } from "react";

import { useApp } from "@/components/app/AppContext";
import { Card, CauseChip, CauseDot, Icon, LevelDot, Title, ago } from "@/components/ui";
import { fmtTime } from "@/lib/format";
import { CAUSE, CAUSE_ORDER, C, ICON, type CauseKind } from "@/lib/theme";
import type { Slowdown, SlowdownCause } from "@/lib/types";

/** Rush-hour rows shown before "Show all". */
const USUAL_PREVIEW = 8;

const kindOf = (s: Slowdown): CauseKind => (s.kind ?? "rush") as CauseKind;
/** "I-45 Gulf Fwy southbound" -> "I-45 Gulf Fwy SB" for compact rows (the design's lists do this). */
const shortRoad = (road: string) => road.replace(/\b(north|south|east|west)bound\b/i, (_, d: string) => `${d[0].toUpperCase()}B`);
const isUnusual = (s: Slowdown) => !!s.kind && s.kind !== "rush";
const causeLabel = (c: SlowdownCause) => (c.kind === "volume" ? CAUSE.volume.label : c.label || CAUSE[c.kind]?.label || c.kind);

// ---- pieces -------------------------------------------------------------------------------------

function Delay({ s }: { s: Slowdown }) {
  return (
    <span className="flex h-[19.5px] shrink-0 items-center gap-1.5">
      <LevelDot level={s.closed ? "heavy" : s.level} />
      <span className="font-num text-[13px] whitespace-nowrap" style={{ color: s.closed ? C.heavyText : C.ink }}>
        {s.closed ? "Closed" : s.delay_min > 0 ? `+${s.delay_min} min` : "<1 min"}
      </span>
    </span>
  );
}

/** "● Crash 60%  ● Rush hour 40%" */
function Shares({ causes }: { causes: SlowdownCause[] }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5 overflow-hidden text-[12px] whitespace-nowrap text-soft">
      {causes.slice(0, 3).map((c, i) => (
        <span key={`${c.kind}-${i}`} className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: CAUSE[c.kind]?.color ?? C.accent }} />
          {causeLabel(c)}
          <span className="font-num text-muted">{c.pct}%</span>
        </span>
      ))}
    </span>
  );
}

function Row({ s, usual }: { s: Slowdown; usual: boolean }) {
  const { go, isDesktop, setScene } = useApp();
  const causes = s.causes.filter((c) => c.pct > 0);
  // Rush-hour rows lead with the road (their titles would all read "Normal 5 PM traffic").
  const title = usual ? shortRoad(s.road) : s.title;
  const sub = usual ? s.place : `${shortRoad(s.road)} · ${s.place}`;
  const showShares = !usual || causes.length > 1;
  return (
    <button
      type="button"
      onClick={() => go({ name: "why", id: s.id })}
      onMouseEnter={isDesktop ? () => setScene({ highlight: s.geometry }) : undefined}
      onMouseLeave={isDesktop ? () => setScene(null) : undefined}
      onFocus={isDesktop ? () => setScene({ highlight: s.geometry }) : undefined}
      onBlur={isDesktop ? () => setScene(null) : undefined}
      aria-label={`${s.road}, ${s.place}. ${s.closed ? "Closed" : `${s.level} traffic, ${s.delay_min > 0 ? `${s.delay_min} minutes` : "under a minute"} of delay`}. ${
        usual ? (s.label ?? "Usual traffic") : s.title
      }. Why it's slow`}
      className="flex w-full cursor-pointer items-center gap-3.5 rounded-2xl bg-card p-3.5 text-left text-ink hover:bg-card-hi"
    >
      <CauseDot kind={kindOf(s)} size={40} />
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className="flex items-start justify-between gap-2">
          <span className="line-clamp-2 text-[15px] leading-[1.3] font-semibold">{title}</span>
          <Delay s={s} />
        </span>
        <span className="truncate text-[13px] text-muted">{sub}</span>
        {showShares && <Shares causes={causes} />}
      </span>
    </button>
  );
}

function Section({ id, title, count, caption, children }: { id: string; title: string; count: number; caption?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-0.5">
        <div className="flex items-baseline justify-between">
          <h2 id={id} className="m-0 text-[17px] font-semibold">
            {title}
          </h2>
          <span className="font-num text-[12px] text-muted">{count}</span>
        </div>
        {caption && <span className="text-[13px] text-muted">{caption}</span>}
      </div>
      {children}
    </section>
  );
}

/** Share of all delay in the city by cause: one stacked bar + legend. */
function DelayShare({ items, active, rushLabel }: { items: Slowdown[]; active: CauseKind | null; rushLabel: string }) {
  const shares = useMemo(() => {
    const min: Partial<Record<CauseKind, number>> = {};
    for (const s of items) for (const c of s.causes) min[c.kind] = (min[c.kind] ?? 0) + Math.max(0, c.minutes);
    const total = Object.values(min).reduce((a, b) => a + (b ?? 0), 0);
    if (total <= 0) return [];
    return (Object.entries(min) as [CauseKind, number][])
      .map(([kind, m]) => ({ kind, pct: (m / total) * 100 }))
      .filter((x) => x.pct >= 0.5)
      .sort((a, b) => b.pct - a.pct);
  }, [items]);
  if (!shares.length) return null;
  const label = (k: CauseKind) => (k === "rush" ? rushLabel : CAUSE[k].label);
  return (
    <Card style={{ gap: 12 }}>
      <div className="flex items-baseline justify-between">
        <h2 className="m-0 text-[17px] font-semibold">Where the delay comes from</h2>
        <span className="text-[12px] text-muted">All roads</span>
      </div>
      <div
        className="flex h-2.5 gap-[2px] overflow-hidden rounded-[5px]"
        style={{ background: C.line }}
        role="img"
        aria-label={shares.map((x) => `${label(x.kind)} ${x.pct < 1 ? "under 1" : Math.round(x.pct)}%`).join(", ")}
      >
        {shares.map((x) => (
          <span
            key={x.kind}
            className="h-full min-w-[3px]"
            style={{ flex: `${x.pct} 1 0%`, background: CAUSE[x.kind].color, opacity: active && active !== x.kind ? 0.3 : 1, transition: "opacity 150ms" }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-soft">
        {shares.map((x) => (
          <span key={x.kind} className="flex items-center gap-1" style={{ opacity: active && active !== x.kind ? 0.5 : 1 }}>
            <span className="h-2 w-2 rounded-full" style={{ background: CAUSE[x.kind].color }} />
            {label(x.kind)}
            <span className="font-num text-muted">{x.pct < 1 ? "<1" : Math.round(x.pct)}%</span>
          </span>
        ))}
      </div>
    </Card>
  );
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-2.5" aria-busy="true" aria-label="Loading slowdowns">
      <div className="h-[92px] rounded-[18px] bg-card motion-safe:animate-pulse" />
      <div className="flex gap-2">
        {[92, 76, 84].map((w, i) => (
          <div key={i} className="h-[34px] rounded-[17px] bg-card motion-safe:animate-pulse" style={{ width: w }} />
        ))}
      </div>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-[76px] rounded-2xl bg-card motion-safe:animate-pulse" />
      ))}
    </div>
  );
}

// ---- screen -------------------------------------------------------------------------------------

export default function Causes() {
  const { slowdowns, clock, causeFilter, setCauseFilter } = useApp();
  const [showAllUsual, setShowAllUsual] = useState(false);

  const items = useMemo(() => slowdowns?.items ?? [], [slowdowns]);
  const filter = (causeFilter as CauseKind | null) ?? null;
  const counts = slowdowns?.counts_by_kind ?? {};
  const kinds = CAUSE_ORDER.filter((k) => (counts[k] ?? 0) > 0 || k === filter);

  const shown = filter ? items.filter((s) => kindOf(s) === filter) : items;
  const unusual = shown.filter(isUnusual);
  const usual = shown.filter((s) => !isUnusual(s));
  const usualShown = showAllUsual || filter === "rush" || usual.length <= USUAL_PREVIEW + 2 ? usual : usual.slice(0, USUAL_PREVIEW);

  const when = clock ? `a ${clock.weekday} at ${fmtTime(clock.now)}` : null;
  const rushLabel = useMemo(
    () => items.flatMap((s) => s.causes).find((c) => c.kind === "rush")?.label || CAUSE.rush.label,
    [items],
  );
  const isRushHour = rushLabel === CAUSE.rush.label;
  const count = slowdowns?.count ?? items.length;
  const updated = slowdowns ? ago(slowdowns.generated_at, clock?.now) || "just now" : "";

  return (
    <div className="flex flex-col gap-4 px-5 pt-14 pb-28 leading-[normal] md:pt-6 md:pb-8">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <Title>Why it&apos;s slow</Title>
          {updated && <span className="font-num shrink-0 text-[12px] text-muted">Updated {updated}</span>}
        </div>
        <span className="text-[14px] text-muted">
          {!slowdowns
            ? "Checking Houston's roads…"
            : count === 0
              ? "No slowdowns in Houston right now"
              : `${count} slowdown${count === 1 ? "" : "s"} in Houston right now`}
        </span>
      </div>

      {!slowdowns ? (
        <Skeleton />
      ) : count === 0 ? (
        <Card className="items-start">
          <span className="flex h-10 w-10 items-center justify-center rounded-full" style={{ background: C.light }}>
            <Icon d={ICON.check} size={20} color={C.onAccent} width={2.4} />
          </span>
          <h2 className="m-0 text-[17px] font-semibold">Traffic is moving normally</h2>
          <p className="m-0 text-[13px] text-muted">Nothing is slowing Houston&apos;s roads right now. When something does, you&apos;ll see what&apos;s causing it here.</p>
        </Card>
      ) : (
        <>
          <DelayShare items={items} active={filter} rushLabel={rushLabel} />

          <div role="group" aria-label="Filter by cause" className="no-scrollbar -mx-5 flex gap-2 overflow-x-auto px-5 md:mx-0 md:flex-wrap md:overflow-visible md:px-0">
            {kinds.map((k) => (
              <CauseChip
                key={k}
                kind={k}
                label={k === "rush" ? rushLabel : undefined}
                count={counts[k] ?? 0}
                active={filter === k}
                onClick={() => setCauseFilter(filter === k ? null : k)}
              />
            ))}
          </div>

          {shown.length === 0 && filter && (
            <Card className="items-start">
              <span className="text-[15px] font-medium">No {(filter === "rush" ? rushLabel : CAUSE[filter].label).toLowerCase()} slowdowns right now.</span>
              <button type="button" onClick={() => setCauseFilter(null)} className="cursor-pointer text-[14px] font-medium text-accent">
                Show every cause
              </button>
            </Card>
          )}

          {unusual.length > 0 && (
            <Section id="unusual-h" title="Unusual right now" count={unusual.length} caption={when ? `Not normal for ${when}` : undefined}>
              {unusual.map((s) => (
                <Row key={s.id} s={s} usual={false} />
              ))}
            </Section>
          )}

          {usual.length > 0 && (
            <Section id="usual-h" title="Usual for this time" count={usual.length} caption={when ? `${isRushHour ? "Rush hour: busy" : "Busy"}, but normal for ${when}` : undefined}>
              {usualShown.map((s) => (
                <Row key={s.id} s={s} usual />
              ))}
              {usualShown.length < usual.length && (
                <button type="button" onClick={() => setShowAllUsual(true)} className="mt-0.5 cursor-pointer self-start text-[14px] font-medium text-accent">
                  Show all {usual.length} roads
                </button>
              )}
            </Section>
          )}
        </>
      )}
    </div>
  );
}
