"use client";

/** My alerts (trip / plan / road-cleared) as toast cards. */

import { Icon } from "@/components/ui";
import { fmtTime } from "@/lib/format";
import { CAUSE, C, ICON, SHADOW } from "@/lib/theme";
import type { AppNotification } from "@/lib/types";

export const NOTE_STYLE: Record<AppNotification["kind"], { icon: string; color: string }> = {
  plan: { icon: ICON.clock, color: C.accent },
  leave_now: { icon: ICON.car, color: C.lightText },
  leave_earlier: { icon: "M12 5v7l-4 2M12 21a9 9 0 1 1 0-18a9 9 0 0 1 0 18z", color: C.moderateText },
  leave_later: { icon: ICON.clock, color: C.muted },
  reroute: { icon: "M4 7h11l-3-3M20 17H9l3 3", color: CAUSE.event.color },
  order_changed: { icon: "M4 7h11l-3-3M20 17H9l3 3", color: CAUSE.event.color },
  cleared: { icon: ICON.check, color: C.lightText },
  info: { icon: "M12 8v.01M11 12h1v5h1M12 21a9 9 0 1 1 0-18a9 9 0 0 1 0 18z", color: C.muted },
};

export function NoteCard({ n, onClose }: { n: AppNotification; onClose?: () => void }) {
  const st = NOTE_STYLE[n.kind] ?? NOTE_STYLE.info;
  return (
    <div className="flex gap-3 rounded-[16px] bg-pop p-3.5" style={{ boxShadow: SHADOW[2] }}>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full" style={{ background: st.color }}>
        <Icon d={st.icon} size={18} color={C.onDot} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-start justify-between gap-2">
          <span className="text-[15px] font-semibold text-ink">{n.title}</span>
          {onClose ? (
            <button type="button" onClick={onClose} aria-label="Dismiss" className="cursor-pointer text-muted hover:text-ink">
              <Icon d={ICON.close} size={16} />
            </button>
          ) : (
            <span className="font-num shrink-0 text-[12px] text-muted">{fmtTime(n.created_at)}</span>
          )}
        </div>
        <span className="text-[13px] leading-snug text-soft">{n.body}</span>
      </div>
    </div>
  );
}

/** `top`: px from the top of the screen (e.g. below the phone demo bar). */
export function Toasts({ toasts, dismiss, top = 12 }: { toasts: AppNotification[]; dismiss: (id: number) => void; top?: number }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed right-3 z-[1400] flex w-[min(92vw,380px)] flex-col gap-2"
      style={{ top }}
    >
      {toasts.map((n, i) => (
        <div key={n.id} className={`toast-in pointer-events-auto ${i > 0 ? "hidden md:block" : ""}`}>
          <NoteCard n={n} onClose={() => dismiss(n.id)} />
        </div>
      ))}
    </div>
  );
}
