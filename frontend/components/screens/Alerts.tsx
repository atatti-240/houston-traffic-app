"use client";

/** Alerts tab (design "Alerts"): what's happening on Houston roads right now (crashes, roadwork,
 * events, weather, trains, heavier than usual) merged with my own alerts (trip / plan / "road
 * cleared"), newest first. Filter chips narrow it to one kind or to "For you". The round button
 * opens alert settings (browser notifications). Tap a road alert for "Why it's slow". */

import { useEffect, useMemo, useRef, useState } from "react";

import { useApp } from "@/components/app/AppContext";
import { NOTE_STYLE } from "@/components/Notifications";
import { FilterChip, Icon } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtTime, parseSim } from "@/lib/format";
import { ALERT_GROUP, CAUSE, C, ICON, type AlertGroup } from "@/lib/theme";
import type { AppNotification, TrafficAlert } from "@/lib/types";

type Filter = "all" | "mine" | AlertGroup;

/** Filter-chip order (as in the design, then the groups the design didn't have room for). */
const GROUP_ORDER: AlertGroup[] = ["incident", "roadwork", "event", "weather", "train", "volume"];

const EMPTY_GROUP: Record<AlertGroup, string> = {
  incident: "No incidents right now",
  roadwork: "No roadwork right now",
  event: "No events right now",
  weather: "No weather alerts right now",
  train: "No trains blocking crossings right now",
  volume: "No roads busier than usual right now",
};

/** The design's sliders icon (two rails with knobs). */
const SLIDERS = "M4 7h10M18 7h2M4 17h2M10 17h10M14 7a2 2 0 1 0 4 0a2 2 0 1 0-4 0M6 17a2 2 0 1 0 4 0a2 2 0 1 0-4 0";

/** Show the skeleton at most this long before offering a retry. */
const LOAD_TIMEOUT_MS = 12000;

// ---- text helpers ----------------------------------------------------------------------------

const DAY_MS = 86400000;
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** The design's clock style: "4:52 pm"; from an earlier day "Sun 6:00 am", a week or more "Sep 20". */
function clockTime(iso: string | null, now: string | null | undefined): string {
  if (!iso) return "";
  const t = fmtTime(iso).toLowerCase();
  if (!now) return t;
  const d = parseSim(iso);
  const days = Math.round((dayStart(parseSim(now)) - dayStart(d)) / DAY_MS);
  if (days <= 0) return t;
  if (days < 7) return `${d.toLocaleDateString([], { weekday: "short" })} ${t}`;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** "I-45 Gulf Fwy southbound" -> "I-45 Gulf Fwy SB" so places fit in two lines (as in the design). */
const shortRoad = (s: string) => s.replace(/\b(north|south|east|west)bound\b/gi, (_, d: string) => `${d[0].toUpperCase()}B`);

/** Backend copy -> the design's: "until 9:00 PM" -> "until 9 pm", "5:14 PM" -> "5:14 pm",
 * "· +0 min" -> "· no delay". */
const tidy = (s: string) =>
  s
    .replace(/\b(\d{1,2})(?::(\d{2}))?\s?([AP])M\b/g, (_, h: string, m: string | undefined, ap: string) =>
      `${h}${m && m !== "00" ? `:${m}` : ""} ${ap.toLowerCase()}m`,
    )
    .replace(/\+0 min\b/g, "no delay");

const timeOf = (iso: string | null) => (iso ? parseSim(iso).getTime() : -Infinity);
const alertIcon = (a: TrafficAlert) => ALERT_GROUP[a.group]?.icon ?? CAUSE[a.kind]?.icon ?? ALERT_GROUP.incident.icon;
const alertColor = (a: TrafficAlert) => ALERT_GROUP[a.group]?.color ?? CAUSE[a.kind]?.color ?? C.muted;

// ---- cards -----------------------------------------------------------------------------------

const CARD = "flex w-full gap-3.5 rounded-2xl bg-card p-3.5 text-left text-ink";

/** 40px colored circle with a white icon. */
function Dot({ color, icon, iconColor = "#FFFFFF" }: { color: string; icon: string; iconColor?: string }) {
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full" style={{ background: color }}>
      <Icon d={icon} size={18} color={iconColor} width={2.2} />
    </span>
  );
}

function CardText({ title, time, place, impact, body }: { title: string; time: string; place?: string; impact?: string; body?: string }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
      <span className="flex justify-between gap-2">
        <span className="min-w-0 text-[15px] font-semibold [overflow-wrap:anywhere] text-ink">{title}</span>
        {time && <span className="font-num shrink-0 text-[12px] whitespace-nowrap text-muted">{time}</span>}
      </span>
      {place && <span className="line-clamp-2 text-[13px] [overflow-wrap:anywhere] text-muted">{place}</span>}
      {impact && <span className="text-[13px] font-medium [overflow-wrap:anywhere] text-soft">{impact}</span>}
      {body && <span className="text-[13px] leading-snug [overflow-wrap:anywhere] text-soft">{body}</span>}
    </span>
  );
}

function AlertCard({ a }: { a: TrafficAlert }) {
  const { go, focus, isDesktop, setScene, slowdowns, segments, clock } = useApp();
  const geometry = a.slowdown_id
    ? (slowdowns?.items.find((s) => s.id === a.slowdown_id)?.geometry ?? segments.find((s) => s.id === a.slowdown_id)?.geometry)
    : undefined;
  const lit = useRef(false);
  const sceneRef = useRef(setScene);
  sceneRef.current = setScene;
  // Don't leave the road glowing if this card goes away while it's hovered.
  useEffect(
    () => () => {
      if (lit.current) sceneRef.current(null);
    },
    [],
  );
  const light = (on: boolean) => {
    if (!isDesktop || !geometry) return;
    lit.current = on;
    setScene(on ? { highlight: geometry } : null);
  };
  const open = () => {
    if (a.slowdown_id) return go({ name: "why", id: a.slowdown_id });
    if (a.lat != null && a.lng != null) focus({ lat: a.lat, lng: a.lng, zoom: 14 });
    go({ name: "map" });
  };
  return (
    <button
      type="button"
      onClick={open}
      onMouseEnter={() => light(true)}
      onMouseLeave={() => light(false)}
      onFocus={() => light(true)}
      onBlur={() => light(false)}
      className={`${CARD} cursor-pointer hover:bg-card-hi`}
    >
      <Dot color={alertColor(a)} icon={alertIcon(a)} />
      {/* A train alert's detail is its caveat ("Sensor down, low confidence"); the rest keep the design's three lines */}
      <CardText
        title={a.title}
        time={clockTime(a.time, clock?.now)}
        place={shortRoad(a.place)}
        impact={tidy(a.impact)}
        body={a.group === "train" && a.detail ? tidy(a.detail) : undefined}
      />
    </button>
  );
}

/** One of my notifications, in the same card style (dark icon: the note colors are light).
 * Trip alerts open that trip. */
function NoteRow({ n }: { n: AppNotification }) {
  const { go, clock } = useApp();
  const [state, setState] = useState<"idle" | "busy" | "gone">("idle");
  const st = NOTE_STYLE[n.kind] ?? NOTE_STYLE.info;
  const text = <CardText title={tidy(n.title)} time={clockTime(n.created_at, clock?.now)} body={n.body ? tidy(n.body) : undefined} />;

  if (n.trip_id == null || state === "gone") {
    return (
      <div className={CARD}>
        <Dot color={st.color} icon={st.icon} iconColor={C.onAccent} />
        {text}
      </div>
    );
  }

  const openTrip = async () => {
    if (state === "busy") return;
    setState("busy");
    try {
      const trip = (await api.trips()).find((t) => t.id === n.trip_id);
      if (!trip) return setState("gone");
      setState("idle");
      go({
        name: "trip",
        to: trip.destination,
        from: trip.origin,
        arriveBy: trip.arrive_by.slice(0, 5),
        safety: trip.safety_weight ?? (trip.safe_path ? 1 : 0),
      });
    } catch {
      setState("idle");
    }
  };
  return (
    <button type="button" onClick={openTrip} aria-busy={state === "busy"} className={`${CARD} cursor-pointer hover:bg-card-hi ${state === "busy" ? "opacity-70" : ""}`}>
      <Dot color={st.color} icon={st.icon} iconColor={C.onAccent} />
      {text}
    </button>
  );
}

function Empty({ title, sub, action }: { title: string; sub?: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-line px-6 py-10 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-card">
        <Icon d={ICON.bell} size={20} color={C.muted} />
      </span>
      <span className="text-[15px] font-semibold text-ink">{title}</span>
      {sub && <span className="max-w-[280px] text-[13px] leading-[1.4] text-balance text-muted">{sub}</span>}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-2 h-9 cursor-pointer rounded-[18px] border border-edge-strong px-4 text-[14px] font-medium text-ink hover:bg-card"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-2.5" aria-busy="true" aria-label="Loading alerts">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex gap-3.5 rounded-2xl bg-card p-3.5 motion-safe:animate-pulse">
          <span className="h-10 w-10 shrink-0 rounded-full bg-line" />
          <span className="flex flex-1 flex-col gap-2 pt-1">
            <span className="h-3.5 w-2/5 rounded bg-line" />
            <span className="h-3 w-4/5 rounded bg-line" />
            <span className="h-3 w-1/2 rounded bg-line" />
          </span>
        </div>
      ))}
    </div>
  );
}

// ---- "For you" chip (FilterChip + a count badge) ----------------------------------------------

function ForYouChip({ selected, count, onClick }: { selected: boolean; count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      aria-label={count ? `For you, ${count} alert${count === 1 ? "" : "s"}` : "For you"}
      className="flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-[18px] px-3.5 text-[14px] font-medium whitespace-nowrap"
      style={
        selected
          ? { background: C.ink, color: "#11141A", border: `1px solid ${C.ink}` }
          : { background: "transparent", color: C.ink, border: `1px solid ${C.edgeStrong}` }
      }
    >
      For you
      {count > 0 && (
        <span
          className="font-num flex h-[18px] min-w-[18px] items-center justify-center rounded-[9px] px-1 text-[11px]"
          style={{ background: C.accent, color: C.onAccent }}
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
    </button>
  );
}

// ---- settings popover (browser notifications) ------------------------------------------------

type Perm = NotificationPermission | "unsupported";

const readPerm = (): Perm => (typeof window === "undefined" || !("Notification" in window) ? "unsupported" : Notification.permission);

/** iPhone/iPad Safari only offers notifications to apps added to the Home Screen. */
const isIOS = () => typeof navigator !== "undefined" && /iPhone|iPad|iPod/.test(navigator.userAgent);

/** The page shows system notifications through the service worker (sw.js). */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    return (await navigator.serviceWorker.getRegistration("/")) ?? (await navigator.serviceWorker.register("/sw.js", { scope: "/" }));
  } catch {
    return null;
  }
}

function usePermission(): [Perm, (p: Perm) => void] {
  const [perm, setPerm] = useState<Perm>(readPerm);
  useEffect(() => {
    // Follow changes made in the browser's site settings while the app is open.
    let status: PermissionStatus | null = null;
    let gone = false;
    const sync = () => setPerm(readPerm());
    navigator.permissions
      ?.query({ name: "notifications" as PermissionName })
      .then((s) => {
        if (gone) return;
        status = s;
        s.addEventListener("change", sync);
      })
      .catch(() => {});
    if (readPerm() === "granted") void registration();
    return () => {
      gone = true;
      status?.removeEventListener("change", sync);
    };
  }, []);
  return [perm, setPerm];
}

function Settings({ onClose }: { onClose: () => void }) {
  const { isDesktop } = useApp();
  const [perm, setPerm] = usePermission();
  const [busy, setBusy] = useState(false);
  const [tested, setTested] = useState<"no" | "sent" | "failed">("no");
  const device = isDesktop ? "desktop" : "phone";

  const turnOn = async () => {
    setBusy(true);
    try {
      // Old Safari returns undefined (callback API): fall back to reading the permission.
      const p = (await Notification.requestPermission()) || readPerm();
      setPerm(p);
      if (p === "granted") await registration();
    } catch {
      setPerm(readPerm());
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    const title = "BlindSpot alerts are on";
    const body = "You'll hear from us when it's time to leave or a road you're watching clears.";
    const reg = await registration();
    // A just-registered worker needs a moment to activate before it can show notifications.
    const active = reg
      ? await Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), 3000))])
      : null;
    try {
      if (active) await active.showNotification(title, { body, icon: "/icon-192.png", tag: "blindspot-test" });
      else new Notification(title, { body, icon: "/icon-192.png" });
      setTested("sent");
    } catch {
      setTested("failed");
    }
  };

  const status =
    perm === "granted"
      ? { text: "On", color: C.light }
      : perm === "denied"
        ? { text: "Blocked", color: C.heavyText }
        : perm === "unsupported"
          ? { text: "Unsupported", color: C.muted }
          : { text: "Off", color: C.muted };

  return (
    <div
      role="dialog"
      aria-label="Alert settings"
      className="fade-in absolute top-[52px] right-0 z-[1200] flex w-[300px] max-w-[calc(100vw-40px)] flex-col gap-3 rounded-[16px] border border-pop-line bg-pop p-4 text-left"
      style={{ boxShadow: "0 10px 32px rgba(0,0,0,0.6)" }}
    >
      <div className="flex items-center justify-between">
        <span className="text-[15px] font-semibold text-ink">Alert settings</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="-mr-1.5 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full text-muted hover:bg-card hover:text-ink"
        >
          <Icon d={ICON.close} size={16} />
        </button>
      </div>

      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-card">
          <Icon d={ICON.bell} size={18} color={C.ink} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[14px] font-medium text-ink">Notifications</span>
          <span className="text-[12px] text-muted">{isDesktop ? "On this computer" : "On this phone"}</span>
        </span>
        <span className="flex items-center gap-1.5 text-[13px] font-medium" style={{ color: status.color }}>
          <span className="h-2 w-2 rounded-full" style={{ background: status.color }} />
          {status.text}
        </span>
      </div>

      <p className="m-0 text-[13px] leading-[1.4] text-soft">
        {perm === "unsupported"
          ? isIOS()
            ? "On iPhone, add BlindSpot to your Home Screen (Share, then Add to Home Screen) to get notifications. Your alerts still show here under For you."
            : "This browser can't show notifications. Your alerts still show here under For you."
          : perm === "denied"
            ? "Blocked in browser settings. Allow notifications for this site there, then come back."
            : perm === "granted"
              ? "You'll get a notification when it's time to leave, your route changes, or a road you're watching clears."
              : "Get a notification when it's time to leave, your route changes, or a road you're watching clears."}
      </p>

      {perm === "default" && (
        <button
          type="button"
          onClick={turnOn}
          disabled={busy}
          className="flex h-11 cursor-pointer items-center justify-center gap-2 rounded-[22px] text-[15px] font-semibold disabled:cursor-default disabled:opacity-60"
          style={{ background: C.accent, color: C.onAccent }}
        >
          <Icon d={ICON.bell} size={18} />
          {busy ? "Waiting for your browser…" : `Turn on ${device} alerts`}
        </button>
      )}
      {perm === "granted" && (
        <button
          type="button"
          onClick={test}
          className="flex h-10 cursor-pointer items-center justify-center gap-2 rounded-[20px] border border-edge-strong text-[14px] font-medium text-ink hover:bg-card"
        >
          {tested === "sent" ? (
            <>
              <Icon d={ICON.check} size={16} color={C.light} /> Sent
            </>
          ) : tested === "failed" ? (
            "Couldn't send. Try again"
          ) : (
            "Send a test alert"
          )}
        </button>
      )}
    </div>
  );
}

// ---- screen ------------------------------------------------------------------------------------

type Item = { key: string; t: number; alert?: TrafficAlert; note?: AppNotification };

export default function Alerts() {
  const { alerts, notes, slowdowns, backendDown, refresh } = useApp();
  const [filter, setFilter] = useState<Filter>("all");
  const [settings, setSettings] = useState(false);
  // Load attempts (Try again bumps it) and the attempt whose load timed out.
  const [tries, setTries] = useState(0);
  const [stuckAt, setStuckAt] = useState(-1);
  const popRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Close the settings popover on outside click / Escape (focus goes back to the button).
  useEffect(() => {
    if (!settings) return;
    const onDown = (e: PointerEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setSettings(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setSettings(false);
      btnRef.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [settings]);

  const groups = useMemo(() => {
    const present = new Set(alerts.map((a) => a.group));
    // Keep the selected chip even if its last alert just went away (so the row doesn't jump).
    return GROUP_ORDER.filter((g) => present.has(g) || filter === g);
  }, [alerts, filter]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    if (filter !== "mine") {
      for (const a of alerts) if (filter === "all" || a.group === filter) out.push({ key: `a-${a.id}`, t: timeOf(a.time), alert: a });
    }
    if (filter === "all" || filter === "mine") {
      for (const n of notes) out.push({ key: `n-${n.id}`, t: timeOf(n.created_at), note: n });
    }
    return out.sort((x, y) => y.t - x.t);
  }, [alerts, notes, filter]);

  // Road alerts arrive with the slowdowns (one request batch in AppContext).
  const loading = slowdowns === null && filter !== "mine";
  useEffect(() => {
    if (!loading) return;
    const t = setTimeout(() => setStuckAt(tries), LOAD_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [loading, tries]);
  const failed = loading && (backendDown || stuckAt === tries);

  let empty: { title: string; sub?: string; action?: { label: string; onClick: () => void } } | null = null;
  if (failed && !items.length) {
    empty = {
      title: "Can't load alerts",
      sub: "BlindSpot can't reach its traffic service right now.",
      action: {
        label: "Try again",
        onClick: () => {
          setTries((t) => t + 1);
          refresh();
        },
      },
    };
  } else if (!items.length && !loading) {
    if (filter === "mine") empty = { title: "No alerts for you yet", sub: "Save a trip or tap Notify me on a slow road." };
    else if (filter === "all") empty = { title: "No alerts right now", sub: "Crashes, roadwork, events and trains in Houston show up here." };
    else empty = { title: EMPTY_GROUP[filter] };
  }

  return (
    <div className="flex flex-col gap-4 px-5 pt-16 pb-28 leading-[normal] md:pt-6 md:pb-8">
      <div className="flex items-center justify-between">
        <h1 className="m-0 text-[30px] font-bold tracking-[-0.02em] text-ink">Alerts</h1>
        <div ref={popRef} className="relative">
          <button
            ref={btnRef}
            type="button"
            aria-label="Alert settings"
            aria-expanded={settings}
            aria-haspopup="dialog"
            onClick={() => setSettings((s) => !s)}
            className={`flex h-11 w-11 cursor-pointer items-center justify-center rounded-full hover:bg-card-hi ${settings ? "bg-card-hi" : "bg-card"}`}
          >
            <Icon d={SLIDERS} size={20} color={C.ink} />
          </button>
          {settings && (
            <Settings
              onClose={() => {
                setSettings(false);
                btnRef.current?.focus();
              }}
            />
          )}
        </div>
      </div>

      <div
        role="group"
        aria-label="Filter alerts"
        className="no-scrollbar -mx-5 flex gap-2 overflow-x-auto px-5 md:mx-0 md:flex-wrap md:overflow-visible md:px-0"
      >
        <FilterChip label="All" selected={filter === "all"} onClick={() => setFilter("all")} />
        <ForYouChip selected={filter === "mine"} count={notes.length} onClick={() => setFilter("mine")} />
        {groups.map((g) => (
          <FilterChip key={g} label={ALERT_GROUP[g].filter} selected={filter === g} onClick={() => setFilter(g)} />
        ))}
      </div>

      {empty ? (
        <Empty title={empty.title} sub={empty.sub} action={empty.action} />
      ) : loading && !items.length ? (
        <Skeleton />
      ) : (
        <div className="flex flex-col gap-2.5">
          {items.map((it) => (it.alert ? <AlertCard key={it.key} a={it.alert} /> : it.note ? <NoteRow key={it.key} n={it.note} /> : null))}
        </div>
      )}
    </div>
  );
}
