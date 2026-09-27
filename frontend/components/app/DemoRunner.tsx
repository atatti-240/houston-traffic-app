"use client";

/** Scripted demo: a Monday in Houston, from the morning commute to "why is it slow" at 5 PM. */

import { useState } from "react";

import { useApp, type AppValue } from "@/components/app/AppContext";
import { showDemoReport } from "@/components/reports/demo";
import { api } from "@/lib/api";
import { C } from "@/lib/theme";

const CRASH_ROAD = "I45S:gulf_ee>i45_610s";

interface Step {
  title: string;
  narration: string;
  run: (a: AppValue) => Promise<void>;
}

/** Set the clock to hh:mm on the day of `now` (by default the clock when the step started). */
async function clockTo(a: AppValue, hhmm: string, now = a.clock?.now) {
  const day = (now ?? "2026-09-28T07:15:00").slice(0, 10);
  const r = await api.advanceClock({ to: `${day}T${hhmm}:00` });
  a.applyClock(r);
  a.pushOut(r.notifications ?? []);
  a.refresh();
}

const STEPS: Step[] = [
  {
    title: "Monday, 7:05 AM in Houston",
    narration: "Open BlindSpot and it asks where you're headed, with the traffic around you right now.",
    run: async (a) => {
      const c = await api.reset();
      a.applyClock(c);
      // The reset deleted every notification (and `a` still has the clock from before it).
      await a.resetNotes();
      await clockTo(a, "07:05", c.now);
      a.setMapTime(null);
      a.setCauseFilter(null);
      a.go({ name: "where" });
    },
  },
  {
    title: "East End → Medical Center by 8:00",
    narration:
      "A traffic-only app sends you down Cullen Blvd. A freight train crosses there most weekday mornings around 7:40, so BlindSpot routes around it and tells you exactly when to leave.",
    run: async (a) => {
      a.go({ name: "trip", from: "eastend", fromName: "East End", to: "medcenter", toName: "Texas Medical Center", arriveBy: "08:00", safety: 0 });
    },
  },
  {
    title: "Live: a train stops on Old Spanish Trail",
    narration: "Live data beats predictions. A train just parked across the new route, so the plan changes before you ever reach it, and says why.",
    run: async (a) => {
      const r = await api.blockCrossing("x_ost", 60);
      a.pushOut(r.notifications);
      a.refresh();
    },
  },
  {
    title: "5 PM: see why Houston is slow",
    narration:
      "Maps show you red. BlindSpot shows you why: rush hour, a concert, a crash, a freight train, lane closures, rain and construction, each on the map.",
    run: async (a) => {
      const c = await api.scenario("evening");
      a.applyClock(c);
      a.pushOut(c.notifications ?? []);
      a.refresh();
      a.go({ name: "map" });
      a.focus([
        [29.84, -95.5],
        [29.68, -95.28],
      ]);
    },
  },
  {
    title: "Tap a cause",
    narration: "Every icon is a reason. This one: a multi-vehicle crash on the Gulf Freeway, two lanes blocked.",
    run: async (a) => {
      const s = a.slowdowns?.items.find((x) => x.id === CRASH_ROAD);
      a.go({ name: "map" });
      if (s) {
        a.focus({ lat: s.lat, lng: s.lng, zoom: 13 });
        setTimeout(() => a.select(s.id), 400);
      }
    },
  },
  {
    title: "Why it's slow",
    narration: "How much of the delay is the crash vs. normal rush hour, and what the speed did over the last two hours.",
    run: async (a) => {
      a.go({ name: "why", id: CRASH_ROAD });
    },
  },
  {
    title: "Look for yourself",
    narration: "Live cameras on the roads that matter. Heavy rain on the West Loop by the Galleria.",
    run: async (a) => {
      // The West Loop camera by name: with live AI feeds on, the I-10 Katy camera would come first.
      a.go({ name: "cameras", area: "Galleria / Uptown", camId: "cam_L610W_i10_610w_i69_610sw" });
    },
  },
  {
    title: "Everything happening, in one list",
    narration: "Incidents, roadwork, events, weather, trains and roads busier than usual, each with how much time it costs you.",
    run: async (a) => {
      a.go({ name: "alerts" });
    },
  },
  {
    title: "Drivers report what they see",
    narration:
      "Crashes, police, hazards, potholes, stalled cars and flooding, reported from the road. Other drivers tap Still there or Not there, so stale reports drop off. Water on Westheimer slows the way into the Galleria.",
    run: (a) => showDemoReport(a, "flooding"),
  },
  {
    title: "Downtown → Galleria, flooding ahead",
    narration: "A trip that crosses a flooded road gets a warning. Turn around, don't drown.",
    run: async (a) => {
      a.go({ name: "trip", from: "downtown", fromName: "Downtown", to: "galleria", toName: "Galleria / Uptown" });
    },
  },
  {
    title: "Downtown → Hobby by 5:45",
    narration:
      "The Gulf Freeway is the usual way to Hobby. With the crash on it, BlindSpot goes around and says why. Slide toward Safer and it stays off crash-prone stretches even on a normal day.",
    run: async (a) => {
      a.go({ name: "trip", from: "downtown", fromName: "Downtown", to: "hobby", toName: "Hobby Airport", arriveBy: "17:45", safety: 0 });
    },
  },
  {
    title: "Notify me when it clears",
    narration: "Watch the crash; when it's cleared up you get an alert, even though it's still rush hour.",
    run: async (a) => {
      await api.watchSlowdown(CRASH_ROAD);
      a.go({ name: "why", id: CRASH_ROAD });
      await clockTo(a, "18:30");
    },
  },
  {
    title: "That's BlindSpot",
    narration: "Train-aware, crash-aware, cause-aware, for Houston. Real TranStar, Train Watch and camera feeds plug into the same interfaces.",
    run: async (a) => {
      a.go({ name: "map" });
    },
  },
];

export default function DemoRunner({ onExit }: { onExit: () => void }) {
  const app = useApp();
  const [index, setIndex] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function go(i: number) {
    setBusy(true);
    setError(null);
    try {
      await STEPS[i].run(app);
      setIndex(i);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const step = index >= 0 ? STEPS[index] : null;
  const last = index === STEPS.length - 1;
  const next = () => (last ? onExit() : go(index + 1));
  const nextLabel = busy ? "…" : index < 0 ? "Start" : last ? "Done" : "Next →";
  const errorBox = error && (
    <p className="mt-2 rounded-lg p-2 text-[13px]" style={{ background: "rgba(255,77,77,0.15)", color: C.heavyText }}>
      Backend error: {error}. Is the API running on :8000?
    </p>
  );

  // Phone: one compact row at the top so the map, route and popups stay visible; tap the title
  // for the narration.
  if (!app.isDesktop) {
    return (
      <div
        className="fixed inset-x-2 top-2 z-[1300] rounded-[18px] border border-pop-line px-3 py-2 text-ink"
        style={{ background: "rgba(17,19,24,0.96)", boxShadow: "0 10px 32px rgba(0,0,0,0.6)" }}
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
          >
            <span className="font-num shrink-0 text-[12px] text-muted">{step ? `${index + 1}/${STEPS.length}` : "Demo"}</span>
            <span className="truncate text-[14px] font-semibold">{step ? step.title : "Scripted demo"}</span>
          </button>
          <button
            type="button"
            onClick={next}
            disabled={busy}
            className="h-8 shrink-0 cursor-pointer rounded-2xl px-3 text-[13px] font-semibold disabled:opacity-60"
            style={{ background: C.accent, color: C.onAccent }}
          >
            {nextLabel}
          </button>
          <button type="button" onClick={onExit} aria-label="Exit demo" className="h-8 w-6 shrink-0 cursor-pointer text-muted">
            ✕
          </button>
        </div>
        {open && (
          <div className="pb-1">
            <p className="mt-1 text-[13px] leading-snug text-soft">
              {step ? step.narration : "A Monday in Houston: the morning commute, a live train, then why everything is slow at 5 PM."}
            </p>
            {index > 0 && (
              <button type="button" onClick={() => go(0)} disabled={busy} className="mt-2 h-8 cursor-pointer rounded-2xl border border-edge-strong px-3 text-[13px]">
                Restart
              </button>
            )}
          </div>
        )}
        {errorBox}
      </div>
    );
  }

  return (
    <div
      className="fixed bottom-6 left-[calc(420px+(100vw-420px)/2)] z-[1300] w-[min(94vw,520px)] -translate-x-1/2 rounded-[18px] border border-pop-line p-4 text-ink"
      style={{ background: "rgba(17,19,24,0.96)", boxShadow: "0 10px 32px rgba(0,0,0,0.6)" }}
    >
      <div className="flex items-center justify-between text-[12px] text-muted">
        <span>Demo {step ? `· step ${index + 1} of ${STEPS.length}` : ""}</span>
        <button type="button" onClick={onExit} className="cursor-pointer hover:text-ink">
          Exit ✕
        </button>
      </div>
      <h3 className="mt-1 text-[18px] font-semibold">{step ? step.title : "Scripted demo"}</h3>
      <p className="mt-1 text-[14px] text-soft">
        {step ? step.narration : "A Monday in Houston: the morning commute, a live train, then why everything is slow at 5 PM."}
      </p>
      {errorBox}
      <div className="mt-3 flex justify-end gap-2">
        {index > 0 && (
          <button type="button" onClick={() => go(0)} disabled={busy} className="h-9 cursor-pointer rounded-[18px] border border-edge-strong px-3.5 text-[14px]">
            Restart
          </button>
        )}
        <button
          type="button"
          onClick={next}
          disabled={busy}
          className="h-9 cursor-pointer rounded-[18px] px-4 text-[14px] font-semibold disabled:opacity-60"
          style={{ background: C.accent, color: C.onAccent }}
        >
          {nextLabel}
        </button>
      </div>
    </div>
  );
}
