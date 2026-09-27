"use client";

/** What the camera AI sees on a live camera: vehicles in view, traffic flow from its rough speeds,
 * the incident check, and where the video really comes from (a Baton Rouge camera standing in). */

import { Icon } from "@/components/ui";
import { C, FLOW, ICON, VEHICLE } from "@/lib/theme";
import type { LiveFeed, LiveFeedDetail } from "@/lib/types";

function Stat({ label, value, sub, color }: { label: string; value: string; sub: string; color?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-xl bg-nav px-2.5 py-2">
      <span className="truncate text-[11px] font-medium tracking-[0.04em] text-muted uppercase">{label}</span>
      <span className="truncate text-[18px] leading-tight font-bold" style={{ color: color ?? C.ink }}>
        {value}
      </span>
      <span className="truncate text-[12px] text-muted">{sub}</span>
    </div>
  );
}

const pct = (p: number | null | undefined) => (p == null ? "" : `${Math.round(p * 100)}%`);
const quote = (t: string | null | undefined) => (t ? `“${t.replace(/\.$/, "")}.”` : "");

function incidentStat(feed: LiveFeed): { value: string; sub: string; color?: string } {
  const inc = feed.incident;
  switch (inc.state) {
    case "confirmed":
      return { value: "Incident", sub: inc.clearing ? "looks clear now" : "confirmed", color: C.heavyText };
    case "possible":
      return { value: "Possible", sub: `${pct(inc.p)} chance`, color: C.moderate };
    case "clear":
      return { value: "Clear", sub: inc.p != null && inc.p >= 0.005 ? `${pct(inc.p)} chance` : "nothing seen", color: C.light };
    case "off":
      return { value: "Off", sub: "needs a Mac" };
    case "error":
      return { value: "Error", sub: "check failed" };
    default:
      return { value: "–", sub: "waiting" };
  }
}

/** The incident line: red when confirmed (it's on the map and in routing), amber when possible. */
function IncidentLine({ feed, clearAfter }: { feed: LiveFeed; clearAfter: number }) {
  const inc = feed.incident;
  if (inc.state !== "confirmed" && inc.state !== "possible") return null;
  const confirmed = inc.state === "confirmed";
  const color = confirmed ? C.heavy : C.moderate;
  const mins = Math.max(1, Math.round(clearAfter / 60));
  return (
    <div
      role="status"
      className="flex gap-2.5 rounded-xl px-3 py-2.5"
      style={{ background: confirmed ? "rgba(255,77,77,0.12)" : "rgba(245,197,24,0.1)", border: `1px solid ${color}` }}
    >
      <Icon d={ICON.info} size={18} color={confirmed ? C.heavyText : C.moderate} className="mt-px shrink-0" />
      <div className="flex min-w-0 flex-col gap-0.5 text-[13px] leading-snug">
        <span className="font-semibold" style={{ color: confirmed ? C.heavyText : C.moderate }}>
          {confirmed ? "Incident confirmed by the camera AI" : `Possible incident (${pct(inc.p)})`}
        </span>
        {inc.text && <span className="text-ink [overflow-wrap:anywhere]">{quote(inc.text)}</span>}
        <span className="text-soft">
          {confirmed
            ? inc.clearing
              ? `The road looks clear again. It clears once it stays clear for ${mins} min.`
              : `It's on the map and routes avoid it until the camera sees a clear road for ${mins} min.`
            : "One check flagged it. Routes change only once 2 of 3 checks agree."}
        </span>
      </div>
    </div>
  );
}

function source(feed: LiveFeed, detail: LiveFeedDetail | null): string {
  const where = `Louisiana DOTD camera ${feed.source_name}`;
  const off = detail?.incident_check === "off" ? " The incident check is off: it runs on the camera AI's Apple-silicon Mac." : "";
  if (feed.test_server)
    return `Recorded Baton Rouge video (${where}) replayed by the camera AI's test server, standing in for this Houston camera. Its incidents are scripted, for demos.${off}`;
  if (feed.replay)
    return `A recorded test clip the camera AI plays on a loop, standing in for this Houston camera.${off}`;
  return `Live video from Baton Rouge (${where}), standing in for this Houston camera until Houston live video is available. Boxes, counts and rough speeds (±30%) come from the team's camera AI.${off}`;
}

export default function LiveFeedPanel({ feed, detail }: { feed: LiveFeed; detail: LiveFeedDetail | null }) {
  const live = feed.status === "live";
  const flow = live && feed.flow ? FLOW[feed.flow] : null;
  const counts = Object.entries(detail?.stats?.counts ?? {}).filter(([, n]) => n > 0);
  const inc = incidentStat(feed);
  return (
    <section aria-label="What the camera AI sees" className="flex flex-col gap-3 rounded-[18px] bg-card p-3.5">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Vehicles" value={live && feed.vehicles != null ? String(feed.vehicles) : "–"} sub="in view" />
        <Stat
          label="Rough speed"
          value={flow?.label ?? "–"}
          color={flow?.color}
          sub={
            live && feed.mph != null
              ? `~${feed.mph} mph`
              : live && feed.flow === "stopped"
                ? "most not moving"
                : live
                  ? "no speed yet"
                  : "waiting"
          }
        />
        <Stat label="Incidents" value={inc.value} sub={inc.sub} color={inc.color} />
      </div>
      {live && counts.length > 0 && (
        <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-[12px] text-soft" aria-label="Vehicle boxes by kind">
          {counts.map(([cls, n]) => (
            <span key={cls} className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-[3px] border-2" style={{ borderColor: VEHICLE[cls]?.color ?? C.soft }} />
              {VEHICLE[cls]?.label ?? cls} <span className="font-num text-muted">{n}</span>
            </span>
          ))}
        </div>
      )}
      <IncidentLine feed={feed} clearAfter={detail?.clear_after_s ?? 120} />
      <p className="m-0 flex gap-2 text-[12px] leading-snug text-muted">
        <Icon d={ICON.info} size={15} color={C.muted} className="mt-px shrink-0" />
        <span>{source(feed, detail)}</span>
      </p>
    </section>
  );
}

/** Under the drawn view of a camera without live video right now. */
export function FeedOffline({ feed }: { feed: LiveFeed | null }) {
  const why = !feed
    ? "Live AI feed offline for this camera. Showing a drawn view of its traffic."
    : feed.status === "missing"
      ? `Live AI feed offline: the camera AI isn't running its Baton Rouge camera ${feed.cv_camera}. Showing a drawn view of this road's traffic.`
      : "Live AI feed offline: can't reach the camera AI right now. Showing a drawn view of this road's traffic.";
  return (
    <p className="m-0 flex gap-2 text-[12px] leading-snug text-muted">
      <Icon d={ICON.info} size={15} color={C.muted} className="mt-px shrink-0" />
      <span>{why}</span>
    </p>
  );
}
