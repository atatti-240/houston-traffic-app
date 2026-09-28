"use client";

/** Share ETA (Trip screen): makes a read-only link to the route on screen with an ETA that keeps
 * itself up to date (POST /shares), then opens the phone's share sheet or copies it on a computer.
 * If neither works, the link is shown to copy by hand. */

import { useEffect, useRef, useState } from "react";

import { useApp } from "@/components/app/AppContext";
import { Icon, PillButton } from "@/components/ui";
import { describeCreateError, prefersShareSheet, sendLink, shareApi, shareText, shareUrl, type ShareMade } from "@/lib/share";
import { C, ICON, SHADOW } from "@/lib/theme";
import type { Route } from "@/lib/types";

const SHARE_ICON = "M12 3v12M8 7l4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1";
const TOAST_MS = 4000;

interface Link {
  key: string;
  url: string;
  made: ShareMade;
}

export default function ShareEta({
  route,
  fromName,
  toName,
  toPoint,
  hasStops = false,
}: {
  /** The route on screen; null while there isn't one (loading, an older result, a multi-stop plan) */
  route: Route | null;
  fromName: string;
  toName: string;
  /** Where the destination pin goes (the place you picked) */
  toPoint?: { lat: number; lng: number } | null;
  hasStops?: boolean;
}) {
  const { clock } = useApp();
  const [link, setLink] = useState<Link | null>(null);
  const [making, setMaking] = useState(false);
  const [manual, setManual] = useState(false);
  const [failed, setFailed] = useState<{ key: string; message: string } | null>(null);
  const [toast, setToast] = useState<{ message: string; note: string } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const field = useRef<HTMLInputElement>(null);

  // One link per route and leave time: tapping again shares the same link.
  const key = route ? JSON.stringify([route.segments.map((s) => s.id), route.depart_at, fromName, toName]) : null;
  const current = link && link.key === key ? link : null;
  const showManual = manual && current !== null;
  // An error goes with the route it was for.
  const error = failed && failed.key === key ? failed.message : null;

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);
  useEffect(() => {
    if (showManual) field.current?.select();
  }, [showManual]);

  const flash = (message: string, made: ShareMade) => {
    setToast({ message, note: `works for ${Math.max(1, Math.round(made.expires_in_min / 60))} h` });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  };

  async function send(l: Link) {
    const res = await sendLink(l.url, shareText(l.made, toName, clock?.now), prefersShareSheet());
    if (res === "copied") flash("Link copied", l.made);
    setManual(res === "manual");
  }

  async function share() {
    if (!route || !key || making) return;
    setFailed(null);
    if (current) return send(current);
    setMaking(true);
    try {
      const made = await shareApi.create({
        segment_ids: route.segments.map((s) => s.id),
        depart_at: route.depart_at,
        origin_name: fromName,
        destination_name: toName,
        destination: toPoint ?? undefined,
      });
      const l = { key, url: shareUrl(made.id), made };
      setLink(l);
      await send(l);
    } catch (e) {
      setFailed({ key, message: describeCreateError(e) });
    } finally {
      setMaking(false);
    }
  }

  async function copyAgain() {
    if (!current) return;
    try {
      await navigator.clipboard.writeText(current.url);
      flash("Link copied", current.made);
      setManual(false);
    } catch {
      field.current?.select();
    }
  }

  const canSheet = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const hint = !route
    ? hasStops
      ? "Share ETA works for trips without extra stops."
      : "Share ETA works once a route is on screen."
    : "Anyone with the link sees this route and a live ETA, until 6 hours after you leave.";

  return (
    <div className="flex flex-col gap-2">
      <PillButton variant="ghost" onClick={share} disabled={!route || making} aria-describedby="share-eta-hint">
        <Icon d={SHARE_ICON} size={18} />
        {making ? "Making a link…" : "Share ETA"}
      </PillButton>
      <span id="share-eta-hint" className="text-center text-[12px] text-balance text-muted">
        {hint}
      </span>
      {error && (
        <p className="m-0 text-center text-[13px] text-heavy-text" role="alert">
          {error}
        </p>
      )}
      {showManual && current && (
        <div className="fade-in flex flex-col gap-2 rounded-[14px] bg-card p-3">
          <label htmlFor="share-eta-link" className="text-[13px] font-medium text-soft">
            Copy this link and send it:
          </label>
          <div className="flex items-center gap-2">
            <input
              id="share-eta-link"
              ref={field}
              readOnly
              value={current.url}
              onFocus={(e) => e.currentTarget.select()}
              className="font-num h-10 min-w-0 flex-1 rounded-[12px] border border-edge bg-bg px-3 text-[16px] text-ink outline-none focus:border-edge-strong md:text-[13px]"
            />
            <button
              type="button"
              onClick={copyAgain}
              className="h-10 shrink-0 cursor-pointer rounded-[20px] px-3.5 text-[14px] font-semibold"
              style={{ background: C.accent, color: C.onAccent }}
            >
              Copy
            </button>
            {canSheet && (
              <button
                type="button"
                onClick={() => send(current)}
                aria-label="Share link"
                className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full border border-edge-strong text-ink"
              >
                <Icon d={SHARE_ICON} size={18} />
              </button>
            )}
          </div>
        </div>
      )}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed top-3 left-1/2 z-[1400] -translate-x-1/2 md:top-auto md:bottom-8 md:left-[calc(50%+210px)]"
      >
        {toast && (
          <div
            className="toast-in flex items-center gap-2.5 rounded-[16px] bg-pop py-2.5 pr-4 pl-3 text-[14px] font-medium whitespace-nowrap text-ink"
            style={{ boxShadow: SHADOW[2] }}
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-full" style={{ background: C.light }}>
              <Icon d={ICON.check} size={14} color={C.onAccent} width={2.6} />
            </span>
            {toast.message}
            <span className="text-[13px] font-normal text-muted">· {toast.note}</span>
          </div>
        )}
      </div>
    </div>
  );
}
