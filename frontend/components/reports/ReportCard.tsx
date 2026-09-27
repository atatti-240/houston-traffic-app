"use client";

/** One driver report: what, where, who and when, what it does to the road, and Still there /
 * Not there. The map pin's popup, and a row on Why it's slow. */

import { useState } from "react";

import { useApp } from "@/components/app/AppContext";
import { Icon } from "@/components/ui";
import { REPORT_KINDS, reportError, voteReport, type DriverReport } from "@/lib/reports";
import { C, ICON } from "@/lib/theme";

/** Colored dot with the kind's icon (the pin's colors). */
export function ReportDot({ r, size = 22 }: { r: Pick<DriverReport, "kind">; size?: number }) {
  const k = REPORT_KINDS[r.kind];
  return (
    <span className="flex shrink-0 items-center justify-center rounded-full" style={{ width: size, height: size, background: k.color }}>
      <Icon d={k.icon} size={Math.round(size * 0.58)} color={k.ink} width={2.3} />
    </span>
  );
}

function effect(r: DriverReport): string {
  if (!r.segment_id) return "Not on a road we track, so it doesn't change routes.";
  if (!r.affects_routing) return "Heads-up only. It doesn't change routes.";
  if (r.outweighed) return "Another incident already slows this road more.";
  if (r.delay_min) return `Slows this road about +${r.delay_min} min. Routes may go around it.`;
  return "Routes may go around it.";
}

function VoteButton({ on, busy, onClick, icon, children }: { on: boolean; busy: boolean; onClick: () => void; icon: string; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-pressed={on}
      className="flex h-9 min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-[18px] px-2 text-[13px] font-semibold whitespace-nowrap disabled:cursor-default disabled:opacity-60"
      style={on ? { background: C.ink, color: "#11141A", border: `1px solid ${C.ink}` } : { background: "transparent", color: C.ink, border: `1px solid ${C.edgeStrong}` }}
    >
      <Icon d={icon} size={15} />
      {children}
    </button>
  );
}

export default function ReportCard({ r, row = false }: { r: DriverReport; row?: boolean }) {
  const { refresh } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const k = REPORT_KINDS[r.kind];

  const vote = async (still: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await voteReport(r, still);
      refresh();
    } catch (e) {
      setError(reportError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`flex flex-col gap-1.5 ${row ? "" : "w-[252px]"}`} style={{ fontFamily: "var(--font-grotesk), system-ui, sans-serif" }}>
      <div className="flex items-center gap-2">
        <ReportDot r={r} />
        <span className="text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
          {k.label}
          {r.demo ? " · Demo" : ""}
        </span>
      </div>
      <div className="text-[16px] leading-tight font-semibold text-ink">{r.title}</div>
      <div className="text-[13px] font-medium text-soft">{r.road ? `${r.road} · ${r.place}` : r.place}</div>
      {r.note && <div className="text-[13px] leading-snug text-ink">“{r.note}”</div>}
      <div className="text-[13px] leading-snug text-muted">{r.provenance}</div>
      <div className="text-[12px] leading-snug" style={{ color: r.affects_routing ? C.moderate : C.muted }}>
        {effect(r)}
      </div>
      {r.mine === "reported" ? (
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="text-[13px] text-soft">You reported this</span>
          <button
            type="button"
            onClick={() => vote(false)}
            disabled={busy}
            className="h-8 cursor-pointer rounded-2xl border border-edge-strong px-3 text-[13px] font-medium text-ink disabled:opacity-60"
          >
            Take it down
          </button>
        </div>
      ) : (
        <div className="mt-1 flex gap-2" role="group" aria-label="Is it still there?">
          <VoteButton on={r.mine === "still_there"} busy={busy} onClick={() => vote(true)} icon={ICON.check}>
            Still there
          </VoteButton>
          <VoteButton on={r.mine === "not_there"} busy={busy} onClick={() => vote(false)} icon={ICON.close}>
            Not there
          </VoteButton>
        </div>
      )}
      {error && (
        <span className="text-[12px] text-heavy-text" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
