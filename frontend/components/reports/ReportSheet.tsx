"use client";

/** The Report sheet: what (crash, police, hazard, pothole, stalled car, flooding), where (where
 * I am, or a spot picked on the map, snapped to the road direction it's on), an optional
 * detail, Send. Phone: a bottom sheet over the map. Desktop: a panel over the map, above the
 * Report button. While picking a spot it steps aside for a "Tap the map" banner. */

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { useApp } from "@/components/app/AppContext";
import { Icon, PillButton } from "@/components/ui";
import {
  NOTE_MAX,
  REPORT_KINDS,
  REPORT_ORDER,
  cancelPicking,
  closeReport,
  editDraft,
  flash,
  inHouston,
  reportError,
  reportsApi,
  selectReport,
  setPreview,
  startPicking,
  upsertReport,
  useReports,
  type SnapResult,
} from "@/lib/reports";
import { C, ICON } from "@/lib/theme";

const LABEL = "text-[13px] font-semibold tracking-[0.08em] text-muted uppercase";

function WhereChoice({ where, onChange }: { where: "here" | "spot"; onChange: (w: "here" | "spot") => void }) {
  const opts: ["here" | "spot", string][] = [
    ["here", "Where I am"],
    ["spot", "Pick on the map"],
  ];
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    onChange(where === "here" ? "spot" : "here");
  };
  return (
    <div role="radiogroup" aria-label="Where is it" onKeyDown={onKey} className="flex h-11 rounded-[22px] bg-card p-1">
      {opts.map(([w, label]) => {
        const on = where === w;
        return (
          <button
            key={w}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(w)}
            className="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-[18px] text-[14px] font-semibold whitespace-nowrap"
            style={on ? { background: C.ink, color: "#11141A" } : { color: C.soft }}
          >
            <Icon d={w === "here" ? ICON.locate : ICON.pin} size={15} />
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** Where it will go: the road direction (with Switch direction), or a pin off our roads. */
function Where({
  snap,
  point,
  failed,
  segmentId,
  hereName,
  hereOff,
  where,
}: {
  snap: SnapResult | null;
  point: { lat: number; lng: number } | null;
  failed: boolean;
  segmentId: string | null;
  hereName: string;
  hereOff: boolean;
  where: "here" | "spot";
}) {
  const other = snap?.other && segmentId === snap.other.segment_id ? snap.other : null;
  const spot = other ?? snap;
  let main: string;
  let sub: string | null = null;
  if (!point) main = "Pick a spot on the map";
  else if (failed) main = where === "here" ? `Near ${hereName}` : "The spot you picked";
  else if (!snap) main = "Finding the road…";
  else if (snap.on_road && spot) {
    main = spot.road ?? "";
    sub = spot.place;
  } else {
    main = snap.place ?? "Here";
    sub = "Not on a road we track: it shows as a pin and doesn't change routes.";
  }
  return (
    <div className="flex items-start gap-2.5 rounded-[14px] bg-card px-3.5 py-2.5" aria-live="polite">
      <Icon d={ICON.pin} size={18} color={C.accent} className="mt-px shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[14px] font-semibold text-ink">{main}</span>
        {sub && <span className="text-[12px] leading-snug text-muted">{sub}</span>}
        {where === "here" && hereOff && <span className="text-[12px] leading-snug text-muted">Your location is off: using {hereName}.</span>}
        {snap?.on_road && snap.other && (
          <button
            type="button"
            onClick={() => editDraft({ segmentId: other ? null : snap.other!.segment_id })}
            className="mt-0.5 cursor-pointer self-start text-[13px] font-medium text-accent"
          >
            Other direction
          </button>
        )}
      </div>
    </div>
  );
}

export default function ReportSheet() {
  const { here, isDesktop, refresh } = useApp();
  const { draft, picking } = useReports();
  const [snap, setSnap] = useState<SnapResult | null>(null);
  const [snapFailed, setSnapFailed] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const opener = useRef<Element | null>(null);

  const open = !!draft && !picking;
  const point = draft ? (draft.where === "here" ? (here ? { lat: here.lat, lng: here.lng } : null) : draft.spot) : null;
  const pointKey = point ? `${point.lat.toFixed(6)},${point.lng.toFixed(6)}` : "";

  // Where the report would go (asked again whenever the point changes).
  useEffect(() => {
    setSnap(null);
    setSnapFailed(false);
    if (!pointKey) return;
    const [lat, lng] = pointKey.split(",").map(Number);
    let live = true;
    reportsApi.snap(lat, lng).then(
      (s) => live && setSnap(s),
      () => live && setSnapFailed(true),
    );
    return () => {
      live = false;
    };
  }, [pointKey]);

  const useOther = !!(draft && snap?.other && draft.segmentId === snap.other.segment_id);
  const chosen = snap?.on_road ? (useOther ? snap.other : snap) : null;
  const pin = chosen ?? (snap ? { lat: snap.lat, lng: snap.lng } : point);
  useEffect(() => {
    setPreview(draft && pin ? { lat: pin.lat, lng: pin.lng } : null);
  }, [draft, pin?.lat, pin?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  // Remember what opened the sheet (focus goes back there), start on the first kind, Escape closes.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      opener.current ??= document.activeElement;
      setError(null);
      requestAnimationFrame(() => sheetRef.current?.querySelector<HTMLElement>("[data-first]")?.focus());
    }
    if (!draft && opener.current) {
      (opener.current as HTMLElement).focus?.({ preventScroll: true });
      opener.current = null;
    }
    wasOpen.current = open;
  }, [open, draft]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") closeReport();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open || !draft || typeof document === "undefined") return null;

  const send = async () => {
    if (!draft.kind || !point || sending) return;
    if (!inHouston(point)) return setError("Reports have to be in the Houston area.");
    setSending(true);
    setError(null);
    try {
      const res = await reportsApi.create({
        kind: draft.kind,
        lat: point.lat,
        lng: point.lng,
        note: draft.note.trim() || undefined,
        segment_id: chosen?.segment_id ?? undefined,
      });
      upsertReport(res.report);
      closeReport();
      selectReport(res.report.id);
      flash(
        !res.merged
          ? "Thanks! Your report is on the map."
          : res.report.mine === "reported"
            ? "You already reported that."
            : "Already reported there: we counted yours as Still there.",
      );
      refresh();
    } catch (e) {
      setError(reportError(e));
    } finally {
      setSending(false);
    }
  };

  const k = draft.kind ? REPORT_KINDS[draft.kind] : null;
  const body = (
    <>
      <div className="flex items-center justify-between">
        <h2 id="report-h" className="m-0 text-[22px] font-bold tracking-[-0.01em] text-ink">
          Report
        </h2>
        <button
          type="button"
          onClick={closeReport}
          aria-label="Close"
          className="-mr-2 flex h-10 w-10 cursor-pointer items-center justify-center rounded-full text-muted hover:bg-card hover:text-ink"
        >
          <Icon d={ICON.close} size={18} />
        </button>
      </div>

      <div className="flex flex-col gap-2">
        <span className={LABEL} id="report-what">
          What do you see?
        </span>
        <div className="grid grid-cols-3 gap-2" role="group" aria-labelledby="report-what">
          {REPORT_ORDER.map((kind, i) => {
            const m = REPORT_KINDS[kind];
            const on = draft.kind === kind;
            return (
              <button
                key={kind}
                type="button"
                data-first={i === 0 ? "" : undefined}
                aria-pressed={on}
                onClick={() => editDraft({ kind })}
                className="flex min-w-0 cursor-pointer flex-col items-center gap-1 rounded-[14px] px-1 pt-2 pb-1.5 hover:bg-card-hi"
                style={{ background: on ? C.cardHi : C.card, border: `1.5px solid ${on ? C.accent : "transparent"}` }}
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-full" style={{ background: m.color }}>
                  <Icon d={m.icon} size={18} color={m.ink} width={2.2} />
                </span>
                <span className="text-[13px] font-semibold text-ink">{m.label}</span>
                <span className="text-[11px] text-muted">{m.hint}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className={LABEL}>Where</span>
        <WhereChoice where={draft.where} onChange={(w) => (w === "spot" ? startPicking() : editDraft({ where: "here", segmentId: null }))} />
        <Where
          snap={snap}
          point={point}
          failed={snapFailed}
          segmentId={draft.segmentId}
          hereName={here?.name ?? "Midtown"}
          hereOff={!here?.fromDevice}
          where={draft.where}
        />
        {draft.where === "spot" && draft.spot && (
          <button type="button" onClick={startPicking} className="cursor-pointer self-start text-[13px] font-medium text-accent">
            Pick another spot
          </button>
        )}
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="flex items-baseline justify-between">
          <span className={LABEL}>Detail</span>
          <span className="font-num text-[11px] text-muted">
            {draft.note.length}/{NOTE_MAX}
          </span>
        </span>
        <input
          type="text"
          value={draft.note}
          maxLength={NOTE_MAX}
          onChange={(e) => editDraft({ note: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
          placeholder="Optional, e.g. left lane blocked"
          className="h-11 rounded-[22px] border border-edge bg-card px-4 text-[15px] text-ink outline-none placeholder:text-muted focus:border-edge-strong"
        />
      </label>

      <div className="flex flex-col gap-2">
        <PillButton onClick={send} disabled={!draft.kind || !point || sending}>
          {sending ? "Sending…" : k ? `Report ${k.label.toLowerCase()}` : "Pick what you see"}
        </PillButton>
        {error && (
          <span className="text-center text-[13px] text-heavy-text" role="alert">
            {error}
          </span>
        )}
        <span className="text-center text-[12px] leading-snug text-muted">
          Drivers passing by say if it&apos;s still there. Gone after{" "}
          {draft.kind === "hazard" || draft.kind === "pothole" || draft.kind === "flooding" ? "2 hours" : "45 min"} unless they do.
        </span>
      </div>
    </>
  );

  if (isDesktop) {
    return createPortal(
      <section
        ref={sheetRef}
        role="dialog"
        aria-labelledby="report-h"
        className="fade-in fixed bottom-[84px] left-[436px] z-[1250] flex max-h-[calc(100dvh-150px)] w-[min(372px,calc(100vw-452px))] flex-col gap-3.5 overflow-y-auto rounded-[18px] border border-pop-line bg-pop p-5 text-ink"
        style={{ boxShadow: "0 10px 32px rgba(0,0,0,0.6)" }}
      >
        {body}
      </section>,
      document.body,
    );
  }
  return createPortal(
    <div className="fixed inset-0 z-[1250] flex flex-col justify-end">
      <div className="absolute inset-0" style={{ background: "rgba(8,9,12,0.5)" }} onClick={closeReport} aria-hidden="true" />
      <section
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-h"
        className="relative flex max-h-[90dvh] flex-col gap-3.5 overflow-y-auto rounded-t-3xl border-t border-line bg-bg px-5 pt-4 pb-6 text-ink"
        style={{ boxShadow: "0 -4px 24px rgba(0,0,0,0.5)" }}
      >
        {body}
      </section>
    </div>,
    document.body,
  );
}

/** "Tap the map where it is" while picking a spot. */
export function PickBanner() {
  const { isDesktop } = useApp();
  const { picking } = useReports();
  useEffect(() => {
    if (!picking) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") cancelPicking();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [picking]);
  if (!picking || typeof document === "undefined") return null;
  return createPortal(
    <div
      role="status"
      className={`fade-in fixed z-[1260] flex items-center gap-3 rounded-[22px] border border-pop-line bg-pop py-2 pr-2 pl-4 text-[14px] text-ink ${
        isDesktop ? "top-16 left-[calc(420px+(100vw-420px)/2)] -translate-x-1/2" : "inset-x-3 top-3"
      }`}
      style={{ boxShadow: "0 10px 32px rgba(0,0,0,0.6)" }}
    >
      <Icon d={ICON.pin} size={18} color={C.accent} className="shrink-0" />
      <span className="flex-1 font-medium">Tap the road where it is</span>
      <button
        type="button"
        onClick={cancelPicking}
        className="h-8 cursor-pointer rounded-2xl border border-edge-strong px-3 text-[13px] font-medium text-ink hover:bg-card"
      >
        Cancel
      </button>
    </div>,
    document.body,
  );
}

/** A short confirmation over the map ("Thanks! Your report is on the map."). */
export function ReportFlash() {
  const { isDesktop } = useApp();
  const { flash: text } = useReports();
  if (!text || typeof document === "undefined") return null;
  return createPortal(
    <div
      role="status"
      className={`toast-in pointer-events-none fixed z-[1260] flex items-center gap-2 rounded-[22px] border border-pop-line bg-pop px-4 py-2.5 text-[14px] font-medium text-ink ${
        isDesktop ? "top-16 left-[calc(420px+(100vw-420px)/2)] -translate-x-1/2" : "inset-x-3 top-3 min-h-11"
      }`}
      style={{ boxShadow: "0 10px 32px rgba(0,0,0,0.6)" }}
    >
      <Icon d={ICON.check} size={16} color={C.light} className="shrink-0" />
      {text}
    </div>,
    document.body,
  );
}
