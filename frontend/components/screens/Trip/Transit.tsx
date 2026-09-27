"use client";

/**
 * Transit tab: walk to a stop, a METRO bus or train (at most one change), walk to where you're going,
 * on the scheduled timetable (no live bus tracking). Up to 3 options; the picked one is spelled out
 * and drawn on the map (walks dotted). Also the next departures from the stops near the start.
 * Asks again every simulated minute, so buses that have left drop off the list.
 */

import { useEffect, useState, type ReactNode } from "react";

import { useApp, type MapPoint } from "@/components/app/AppContext";
import { Card, Icon } from "@/components/ui";
import { fmtDayTime, fmtTime, parseSim } from "@/lib/format";
import {
  fmtDistance,
  fmtMinutes,
  MODE_ICON,
  travelApi,
  type LatLng,
  type ModeLine,
  type TransitNearby,
  type TransitOption,
  type TransitPlan,
  type TransitRoute,
  type TransitStatus,
} from "@/lib/modes";
import { C } from "@/lib/theme";

import { BigLine, describeError, ErrorLine, Loading, sheetPadding } from "./modeParts";

// METRO's terms: the legend (from the API), and this note wherever the name METRO is used.
const TRADEMARK = "* METRO is the registered trademark of the Metropolitan Transit Authority of Harris County, Texas. All rights reserved.";

const STATUS_TITLE: Record<Exclude<TransitStatus, "ok">, string> = {
  not_loaded: "Transit data isn't loaded yet",
  outside_dates: "No timetable for this day",
  no_service: "No service that day",
  no_stops_start: "No stops near the start",
  no_stops_end: "No stops near your destination",
  no_trips: "No bus or train soon",
};

function minutesBetween(a: string, b: string): number {
  return Math.round((parseSim(b).getTime() - parseSim(a).getTime()) / 60000);
}

/** A time, with the weekday when it's on another day than `ref`. */
function when(iso: string, ref: string | undefined): string {
  return ref && iso.slice(0, 10) !== ref.slice(0, 10) ? fmtDayTime(iso) : fmtTime(iso);
}

function inTime(min: number | null): string | null {
  if (min === null || min <= 0 || min > 180) return null;
  return `in ${fmtMinutes(min)}`;
}

function longDate(iso: string | null): string {
  return iso ? parseSim(iso).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) : "";
}

/** "Walk 6 min, Bus 82 Westheimer leaves 5:42 PM from Westheimer Rd @ Post Oak Blvd, 14 min, walk 3 min" */
export function optionSummary(o: TransitOption): string {
  return o.legs
    .map((l, i) => {
      if (l.kind === "walk") return `${i ? "walk" : "Walk"} ${l.minutes} min`;
      const what = l.route.mode === "rail" ? `${l.route.name} train` : `Bus ${l.route.name}`;
      return `${what} leaves ${fmtTime(l.depart_at)} from ${l.from.name}, ${l.minutes} min`;
    })
    .join(", ");
}

function RouteBadge({ route, short }: { route: TransitRoute; short?: boolean }) {
  const text = short && route.mode !== "rail" ? route.short_name : route.name;
  return (
    <span
      className="inline-flex h-6 max-w-full min-w-0 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] font-semibold whitespace-nowrap"
      style={{ background: route.color ?? C.accent, color: route.text_color ?? C.onAccent }}
    >
      <Icon d={route.mode === "rail" ? MODE_ICON.rail : MODE_ICON.transit} size={13} className="shrink-0" />
      <span className="truncate">{text}</span>
    </span>
  );
}

/** walk 7 › [82] › walk 4 */
function LegChips({ o }: { o: TransitOption }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5" aria-hidden="true">
      {o.legs.map((l, i) => (
        <span key={i} className="flex min-w-0 items-center gap-1.5">
          {i > 0 && <span className="text-muted">›</span>}
          {l.kind === "walk" ? (
            <span className="font-num flex items-center gap-0.5 text-[12px] text-soft">
              <Icon d={MODE_ICON.walk} size={14} />
              {l.minutes}
            </span>
          ) : (
            <RouteBadge route={l.route} short />
          )}
        </span>
      ))}
    </span>
  );
}

function Step({ icon, iconBg, last, children }: { icon: string; iconBg?: string; last?: boolean; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex flex-col items-center" aria-hidden="true">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full" style={{ background: iconBg ?? C.cardHi }}>
          <Icon d={icon} size={15} color={iconBg ? "#FFFFFF" : C.soft} />
        </span>
        {!last && <span className="my-1 w-0.5 flex-1 bg-line" />}
      </span>
      <div className={`flex min-w-0 flex-1 flex-col gap-1 pt-1 ${last ? "" : "pb-3"}`}>{children}</div>
    </li>
  );
}

/** The picked option, leg by leg. */
function Legs({ o, toName }: { o: TransitOption; toName: string }) {
  let ready: number | null = null; // when you get to the next stop (ms), to work out waits
  let rides = 0;
  return (
    <ol className="m-0 flex list-none flex-col p-0">
      {o.legs.map((l, i) => {
        const last = i === o.legs.length - 1;
        if (l.kind === "walk") {
          if (ready !== null) ready += l.minutes * 60000;
          return (
            <Step key={i} icon={MODE_ICON.walk} last={last}>
              <span className="text-[14px] leading-snug text-ink">
                Walk {l.minutes} min to {l.to ? l.to.name : toName}
              </span>
              <span className="text-[12px] text-muted">About {fmtDistance(l.meters)}</span>
            </Step>
          );
        }
        const first = rides++ === 0;
        const wait = ready !== null ? Math.round((parseSim(l.depart_at).getTime() - ready) / 60000) : 0;
        ready = parseSim(l.arrive_at).getTime();
        return (
          <Step key={i} icon={l.route.mode === "rail" ? MODE_ICON.rail : MODE_ICON.transit} iconBg={l.route.color ?? C.accent} last={last}>
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <RouteBadge route={l.route} />
              <span className="min-w-0 text-[13px] text-soft">toward {l.headsign}</span>
            </span>
            <span className="text-[14px] leading-snug text-ink">
              Get on at {l.from.name} · <span className="font-num">{fmtTime(l.depart_at)}</span>
              {wait >= 1 && <span className="text-muted"> (wait {wait} min)</span>}
            </span>
            <span className="text-[13px] leading-snug text-soft">
              Get off at {l.to.name} · <span className="font-num">{when(l.arrive_at, l.depart_at)}</span>
              <span className="text-muted">
                {" "}
                ({l.minutes} min, {l.stops} stop{l.stops === 1 ? "" : "s"})
              </span>
            </span>
            {first && o.later.length > 0 && (
              <span className="text-[12px] text-muted">
                Next ones: <span className="font-num">{o.later.map((t) => fmtTime(t)).join(", ")}</span>
              </span>
            )}
          </Step>
        );
      })}
    </ol>
  );
}

function Nearby({ nearby, fromName }: { nearby: TransitNearby[]; fromName: string }) {
  if (!nearby.length) return null;
  return (
    <Card>
      <h2 className="m-0 text-[13px] font-semibold tracking-[0.08em] text-muted uppercase">
        Next departures near {fromName || "you"}
      </h2>
      {nearby.map((n, i) => (
        <div key={n.stop.id} className={`flex flex-col gap-2 ${i ? "border-t border-line pt-2.5" : ""}`}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-[14px] font-semibold">{n.stop.name}</span>
            <span className="font-num shrink-0 text-[12px] text-muted">{n.walk_min} min walk</span>
          </div>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {n.departures.map((d) => (
              <li key={`${d.route.id}-${d.headsign}`} className="flex min-w-0 items-center gap-2">
                <RouteBadge route={d.route} short />
                <span className="min-w-0 flex-1 truncate text-[13px] text-soft">to {d.headsign}</span>
                <span className="font-num shrink-0 text-[13px] text-ink">{fmtTime(d.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Card>
  );
}

function Credits({ plan }: { plan: TransitPlan }) {
  const f = plan.feed;
  return (
    <p className="m-0 flex flex-col gap-1 text-[12px] leading-snug text-muted">
      <span>
        Scheduled times from METRO&apos;s* timetable
        {f?.start_date && f.end_date ? ` (${longDate(f.start_date)} to ${longDate(f.end_date)})` : ""}. No live bus tracking; walking
        times are estimates.
      </span>
      <span className="text-soft">{plan.legend}*</span>
      <span>{TRADEMARK}</span>
    </p>
  );
}

export default function Transit({ start, end, fromName, toName }: { start: LatLng; end: LatLng; fromName: string; toName: string }) {
  const { clock, setScene, isDesktop, screen, go } = useApp();
  const key = JSON.stringify({ start, end });
  const minute = clock?.now.slice(0, 16);
  const [res, setRes] = useState<{ key: string; plan?: TransitPlan; error?: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const [sel, setSel] = useState(0);
  const [seenKey, setSeenKey] = useState(key);
  if (seenKey !== key) {
    setSeenKey(key);
    setSel(0);
  }

  // Ask again each simulated minute. A failed refresh keeps the answer already on screen.
  useEffect(() => {
    let live = true;
    travelApi.transitTrip({ origin: start, destination: end }).then(
      (plan) => live && setRes({ key, plan }),
      (e: unknown) => live && setRes((prev) => (prev?.key === key && prev.plan ? prev : { key, error: describeError(e) })),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, minute, retry]);

  const current = res?.key === key ? res : null;
  const plan = current?.plan;
  const options = plan?.options ?? [];
  const pick = options.length ? Math.min(sel, options.length - 1) : -1;
  const o: TransitOption | undefined = options[pick];

  // The map: the picked option's walks (dotted) and rides, the stops to get on and off at.
  useEffect(() => {
    const points: MapPoint[] = [
      { ...start, kind: "start", label: fromName },
      { ...end, kind: "end", label: toName },
    ];
    const lines: ModeLine[] = o ? o.legs.map((l) => ({ kind: l.kind === "walk" ? "walk" : "ride", positions: l.geometry })) : [];
    const stops = o
      ? o.legs.flatMap((l) =>
          l.kind === "ride"
            ? [
                { lat: l.from.lat, lng: l.from.lng, label: `Get on: ${l.from.name}` },
                { lat: l.to.lat, lng: l.to.lng, label: `Get off: ${l.to.name}` },
              ]
            : [],
        )
      : [];
    setScene({
      modeRoute: o ? { lines, stops } : undefined,
      points,
      fit: lines.length ? lines.flatMap((l) => l.positions) : points.map((p) => [p.lat, p.lng]),
      fitPadding: sheetPadding(isDesktop),
      markers: false,
    });
    // `o` is recomputed each render: redraw when the plan or the pick changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, pick, isDesktop, key, fromName, toName]);

  if (!current) return <Loading />;
  if (!plan)
    return (
      <ErrorLine
        message={current.error ?? "Something went wrong."}
        onRetry={() => {
          setRes(null);
          setRetry((n) => n + 1);
        }}
      />
    );

  if (plan.status !== "ok" || !o)
    return (
      <>
        <Card>
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-card-hi" aria-hidden="true">
              <Icon d={MODE_ICON.transit} size={18} color={C.soft} />
            </span>
            <div className="flex min-w-0 flex-col gap-1" role="status">
              <h1 className="m-0 text-[17px] leading-snug font-semibold">
                {plan.status === "ok" ? STATUS_TITLE.no_trips : STATUS_TITLE[plan.status]}
              </h1>
              {plan.status === "not_loaded" ? (
                <span className="text-[14px] leading-snug text-soft">
                  Run <code className="font-num text-ink">make transit</code> to download METRO&apos;s* bus and rail timetable, then try again.
                </span>
              ) : (
                <span className="text-[14px] leading-snug text-soft">{plan.message}</span>
              )}
            </div>
          </div>
          {plan.status === "not_loaded" && (
            <button
              type="button"
              onClick={() => setRetry((n) => n + 1)}
              className="self-start cursor-pointer text-[14px] font-medium text-accent"
            >
              Try again
            </button>
          )}
        </Card>
        <Nearby nearby={plan.nearby} fromName={fromName} />
        {plan.status === "not_loaded" ? <span className="text-[12px] text-muted">{TRADEMARK}</span> : <Credits plan={plan} />}
      </>
    );

  const now = clock?.now;
  const leaveIn = now ? minutesBetween(now, o.leave_at) : null;
  const walkInstead = plan.walk_only_min !== null && plan.walk_only_min <= o.minutes;

  return (
    <>
      <BigLine
        title={leaveIn !== null && leaveIn <= 0 ? "Leave now" : `Leave at ${when(o.leave_at, now)}`}
        aside={inTime(leaveIn) && <span className="font-num text-[13px] text-muted">{inTime(leaveIn)}</span>}
      >
        <span className="text-[14px] text-soft">
          Arrive <span className="font-num">{when(o.arrive_at, o.leave_at)}</span> · <span className="font-num">{fmtMinutes(o.minutes)}</span> ·{" "}
          <span className="font-num">{o.walk_min} min</span> walking
          {o.changes ? ` · ${o.changes} change` : ""}
        </span>
        <span className="text-[13px] leading-snug text-muted">{optionSummary(o)}</span>
        {walkInstead && (
          <span className="flex flex-wrap items-baseline gap-x-2 text-[13px] text-soft">
            Walking there takes about {fmtMinutes(plan.walk_only_min as number)}.
            {screen.name === "trip" && (
              <button type="button" onClick={() => go({ ...screen, travel: "walk" })} className="cursor-pointer font-medium text-accent">
                Walk instead
              </button>
            )}
          </span>
        )}
      </BigLine>

      {options.length > 1 && (
        <div role="radiogroup" aria-label="Transit options" className="flex flex-col gap-2">
          {options.map((opt, i) => {
            const on = i === pick;
            return (
              <button
                key={`${opt.leave_at}-${i}`}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={`${fmtTime(opt.leave_at)} to ${fmtTime(opt.arrive_at)}, ${fmtMinutes(opt.minutes)}: ${optionSummary(opt)}`}
                onClick={() => setSel(i)}
                className="flex cursor-pointer flex-col gap-2 rounded-[14px] px-3.5 py-3 text-left"
                style={{ background: on ? C.cardHi : C.card, border: `1px solid ${on ? C.accent : "transparent"}` }}
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="font-num text-[15px] text-ink">
                    {fmtTime(opt.leave_at)} → {when(opt.arrive_at, opt.leave_at)}
                  </span>
                  <span className="font-num shrink-0 text-[13px] text-soft">{fmtMinutes(opt.minutes)}</span>
                </span>
                <LegChips o={opt} />
              </button>
            );
          })}
        </div>
      )}

      <Card>
        <h2 className="m-0 text-[13px] font-semibold tracking-[0.08em] text-muted uppercase">Step by step</h2>
        <Legs o={o} toName={toName} />
      </Card>
      <Nearby nearby={plan.nearby} fromName={fromName} />
      <Credits plan={plan} />
    </>
  );
}
