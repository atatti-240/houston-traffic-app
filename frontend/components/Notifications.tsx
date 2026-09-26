"use client";

/** My alerts (trip / plan / road-cleared) as dark toast cards. */

import { Icon } from "@/components/ui";
import { fmtTime } from "@/lib/format";
import { C, ICON } from "@/lib/theme";
import type { AppNotification } from "@/lib/types";

export const NOTE_STYLE: Record<AppNotification["kind"], { icon: string; color: string }> = {
  plan: { icon: ICON.clock, color: C.accent },
  leave_now: { icon: ICON.car, color: C.light },
  leave_earlier: { icon: "M12 5v7l-4 2M12 21a9 9 0 1 1 0-18a9 9 0 0 1 0 18z", color: C.moderate },
  leave_later: { icon: ICON.clock, color: C.muted },
  reroute: { icon: "M4 7h11l-3-3M20 17H9l3 3", color: "#B07CE8" },
  order_changed: { icon: "M4 7h11l-3-3M20 17H9l3 3", color: "#B07CE8" },
  cleared: { icon: ICON.check, color: C.light },
  info: { icon: "M12 8v.01M11 12h1v5h1M12 21a9 9 0 1 1 0-18a9 9 0 0 1 0 18z", color: C.muted },
};

export function NoteCard({ n, onClose }: { n: AppNotification; onClose?: () => void }) {
  const st = NOTE_STYLE[n.kind] ?? NOTE_STYLE.info;
  return (
    <div className="flex gap-3 rounded-[16px] border border-pop-line bg-pop p-3.5" style={{ boxShadow: "0 10px 32px rgba(0,0,0,0.6)" }}>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full" style={{ background: st.color }}>
        <Icon d={st.icon} size={18} color={C.onAccent} />
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

export function Toasts({ toasts, dismiss }: { toasts: AppNotification[]; dismiss: (id: number) => void }) {
  return (
    <div className="pointer-events-none fixed top-3 right-3 z-[1400] flex w-[min(92vw,380px)] flex-col gap-2">
      {toasts.map((n, i) => (
        <div key={n.id} className={`toast-in pointer-events-auto ${i > 0 ? "hidden md:block" : ""}`}>
          <NoteCard n={n} onClose={() => dismiss(n.id)} />
        </div>
      ))}
    </div>
  );
}
