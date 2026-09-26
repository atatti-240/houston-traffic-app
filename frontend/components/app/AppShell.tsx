"use client";

/**
 * Layout.
 *  Phone: the traffic map fills the screen. "map" draws its overlays + sheet on top of it,
 *         "trip" is a sheet over the lower part (route visible above), every other screen
 *         is a full-screen panel. Bottom nav on tab screens.
 *  Desktop (>= 768px): a 420px panel on the left with the current screen (+ bottom nav),
 *         the map with its controls on the right.
 */

import { useCallback, useRef, useState, type ReactNode } from "react";

import { AppProvider, tabOf, useApp, useNewNotifications, type Screen, type Tab } from "@/components/app/AppContext";
import DemoRunner from "@/components/app/DemoRunner";
import MapChrome from "@/components/app/MapChrome";
import ClientTrafficMap from "@/components/map/ClientTrafficMap";
import { Toasts } from "@/components/Notifications";
import Alerts from "@/components/screens/Alerts";
import Cameras from "@/components/screens/Cameras";
import Causes from "@/components/screens/Causes";
import LiveMap from "@/components/screens/LiveMap";
import Trip from "@/components/screens/Trip";
import WhereTo from "@/components/screens/WhereTo";
import WhySlow from "@/components/screens/WhySlow";
import { Icon } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtDayTime } from "@/lib/format";
import { C, ICON } from "@/lib/theme";
import type { AppNotification } from "@/lib/types";

function ScreenView({ screen }: { screen: Screen }) {
  // key: remount when the target changes (e.g. another road), so screens start fresh
  switch (screen.name) {
    case "where":
      return <WhereTo />;
    case "trip":
      return <Trip key={JSON.stringify(screen.to)} />;
    case "map":
      return <LiveMap />;
    case "cameras":
      return <Cameras key={`${screen.area}-${screen.camId}`} />;
    case "causes":
      return <Causes />;
    case "why":
      return <WhySlow key={screen.id} />;
    case "alerts":
      return <Alerts />;
  }
}

const TABS: { tab: Tab; label: string; icon: string }[] = [
  { tab: "map", label: "Map", icon: ICON.map },
  { tab: "causes", label: "Causes", icon: ICON.causes },
  { tab: "alerts", label: "Alerts", icon: ICON.bell },
];

function BottomNav() {
  const { screen, tab, notes } = useApp();
  const current = tabOf(screen);
  const unread = notes.filter((n) => n.kind !== "info").length;
  return (
    <nav
      aria-label="Main"
      className="pointer-events-auto grid h-[84px] shrink-0 grid-cols-3 gap-2 border-t border-line px-6 pt-2 pb-6"
      style={{ background: C.nav }}
    >
      {TABS.map((t) => {
        const on = current === t.tab;
        return (
          <button
            key={t.tab}
            type="button"
            onClick={() => tab(t.tab)}
            aria-current={on ? "page" : undefined}
            className="relative flex cursor-pointer flex-col items-center justify-center gap-1 text-[12px]"
            style={{ color: on ? C.accent : C.muted, fontWeight: on ? 600 : 500 }}
          >
            <Icon d={t.icon} />
            {t.label}
            {t.tab === "alerts" && unread > 0 && (
              <span className="absolute top-0 left-1/2 ml-2 h-2 w-2 rounded-full" style={{ background: C.heavy }} aria-label={`${unread} alerts`} />
            )}
          </button>
        );
      })}
    </nav>
  );
}

/** Simulated clock + demo controls (small, out of the design's way). */
function DemoBar({ onDemo }: { onDemo: () => void }) {
  const { clock, applyClock, pushOut, refresh } = useApp();
  const advance = async (minutes: number) => {
    const r = await api.advanceClock({ minutes });
    applyClock(r);
    pushOut(r.notifications ?? []);
    refresh();
  };
  return (
    <div
      className="pointer-events-auto flex items-center gap-1 rounded-[18px] border border-edge py-1 pr-1 pl-3 text-[12px]"
      style={{ background: "rgba(17,19,24,0.92)" }}
    >
      {clock && (
        <span className="font-num mr-1 text-soft" title="Simulated time">
          {fmtDayTime(clock.now)}
        </span>
      )}
      <button type="button" onClick={() => advance(15)} className="h-7 cursor-pointer rounded-[14px] px-2 text-ink hover:bg-card" title="Advance simulated time 15 min">
        +15m
      </button>
      <button type="button" onClick={onDemo} className="h-7 cursor-pointer rounded-[14px] px-2.5 font-semibold" style={{ background: C.accent, color: C.onAccent }}>
        ▶ Demo
      </button>
    </div>
  );
}

function Shell() {
  const app = useApp();
  const { screen, isDesktop, backendDown, refresh } = app;
  const [toasts, setToasts] = useState<AppNotification[]>([]);
  const [demo, setDemo] = useState(false);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const onNew = useCallback((fresh: AppNotification[]) => {
    setToasts((t) => [...fresh, ...t].slice(0, 3));
    for (const n of fresh) {
      timers.current.set(
        n.id,
        setTimeout(() => {
          timers.current.delete(n.id);
          setToasts((t) => t.filter((x) => x.id !== n.id));
        }, 9000),
      );
      if (typeof Notification !== "undefined" && Notification.permission === "granted" && navigator.serviceWorker?.controller) {
        navigator.serviceWorker.ready
          .then((reg) => reg.showNotification(n.title, { body: n.body, icon: "/icon-192.png", tag: `n-${n.id}` }))
          .catch(() => {});
      }
    }
  }, []);
  useNewNotifications(onNew);

  const tabScreen = tabOf(screen) !== null;
  const isMap = screen.name === "map";
  const isTrip = screen.name === "trip";

  let panel: ReactNode;
  if (isDesktop) {
    panel = (
      <div className="absolute inset-y-0 left-0 z-[1000] flex w-[420px] flex-col border-r border-line bg-bg">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ScreenView screen={screen} />
        </div>
        {tabScreen && <BottomNav />}
      </div>
    );
  } else if (isMap) {
    panel = (
      <div className="pointer-events-none absolute inset-0 z-[1000] flex flex-col justify-end">
        <ScreenView screen={screen} />
        <BottomNav />
      </div>
    );
  } else if (isTrip) {
    panel = (
      <div className="absolute inset-x-0 bottom-0 z-[1000] flex max-h-[64dvh] flex-col rounded-t-3xl border-t border-line bg-bg" style={{ boxShadow: "0 -4px 24px rgba(0,0,0,0.5)" }}>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ScreenView screen={screen} />
        </div>
      </div>
    );
  } else {
    panel = (
      <div className="absolute inset-0 z-[1000] flex flex-col bg-bg">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ScreenView screen={screen} />
        </div>
        {tabScreen && <BottomNav />}
      </div>
    );
  }

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-bg text-ink">
      <div className={isDesktop ? "absolute inset-y-0 right-0 left-[420px]" : "absolute inset-0"}>
        <ClientTrafficMap />
        {isDesktop && <MapChrome />}
        {isDesktop && (
          <div className="absolute top-4 left-1/2 z-[950] -translate-x-1/2">
            <DemoBar onDemo={() => setDemo(true)} />
          </div>
        )}
      </div>
      {panel}
      {!isDesktop && isMap && (
        <div className="absolute top-3 right-4 z-[1100]">
          <DemoBar onDemo={() => setDemo(true)} />
        </div>
      )}
      {backendDown && (
        <div className="absolute top-16 left-1/2 z-[1500] -translate-x-1/2 rounded-xl px-4 py-2 text-sm text-white" style={{ background: C.heavy }}>
          Can&apos;t reach the API. Start it with <code>make backend</code>.{" "}
          <button type="button" className="cursor-pointer underline" onClick={refresh}>
            Retry
          </button>
        </div>
      )}
      <Toasts
        toasts={toasts}
        dismiss={(id) => {
          clearTimeout(timers.current.get(id));
          timers.current.delete(id);
          setToasts((t) => t.filter((x) => x.id !== id));
        }}
      />
      {demo && <DemoRunner onExit={() => setDemo(false)} />}
    </main>
  );
}

export default function AppShell() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
