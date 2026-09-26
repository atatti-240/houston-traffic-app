"use client";

import { fmtTime } from "@/lib/format";
import type { AppNotification } from "@/lib/types";

const ICON: Record<AppNotification["kind"], string> = {
  plan: "🗓️",
  leave_now: "🚗",
  leave_earlier: "⏰",
  leave_later: "😌",
  reroute: "🔀",
  info: "ℹ️",
};

const TONE: Record<AppNotification["kind"], string> = {
  plan: "border-blue-500",
  leave_now: "border-green-600",
  leave_earlier: "border-amber-500",
  leave_later: "border-slate-400",
  reroute: "border-violet-600",
  info: "border-slate-400",
};

function Card({ n, onClose }: { n: AppNotification; onClose?: () => void }) {
  return (
    <div className={`rounded-lg border-l-4 bg-white p-3 shadow ${TONE[n.kind]}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-semibold">
          {ICON[n.kind]} {n.title}
        </div>
        {onClose && (
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700" aria-label="Dismiss">
            ✕
          </button>
        )}
      </div>
      <div className="mt-1 text-sm text-slate-700">{n.body}</div>
      <div className="mt-1 text-[11px] text-slate-400">{fmtTime(n.created_at)}</div>
    </div>
  );
}

export function Toasts({ toasts, dismiss }: { toasts: AppNotification[]; dismiss: (id: number) => void }) {
  return (
    <div className="pointer-events-none fixed right-3 top-32 z-[1200] md:top-16 flex w-[min(92vw,360px)] flex-col gap-2">
      {toasts.map((n, i) => (
        <div key={n.id} className={`toast-in pointer-events-auto ${i > 0 ? "hidden md:block" : ""}`}>
          <Card n={n} onClose={() => dismiss(n.id)} />
        </div>
      ))}
    </div>
  );
}

export function NotificationDrawer(props: {
  open: boolean;
  onClose: () => void;
  items: AppNotification[];
  pushState: NotificationPermission | "unsupported";
  onEnablePush: () => void;
}) {
  if (!props.open) return null;
  return (
    <div className="fixed inset-0 z-[1300] flex justify-end bg-black/20" onClick={props.onClose}>
      <aside className="h-full w-[min(92vw,380px)] overflow-y-auto bg-slate-50 p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Alerts</h2>
          <button onClick={props.onClose} className="text-slate-500" aria-label="Close">
            ✕
          </button>
        </div>
        {props.pushState === "default" && (
          <button onClick={props.onEnablePush} className="mb-3 w-full rounded-lg bg-blue-600 py-2 text-sm font-semibold text-white">
            Enable phone/desktop notifications
          </button>
        )}
        {props.pushState === "denied" && (
          <p className="mb-3 text-xs text-slate-500">Browser notifications are blocked; alerts still show here.</p>
        )}
        <div className="flex flex-col gap-2">
          {props.items.length === 0 && <p className="text-sm text-slate-500">No alerts yet. Save a trip to get them.</p>}
          {props.items.map((n) => (
            <Card key={n.id} n={n} />
          ))}
        </div>
      </aside>
    </div>
  );
}
