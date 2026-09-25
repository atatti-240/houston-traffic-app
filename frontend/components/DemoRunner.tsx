"use client";

import { useState } from "react";

export interface DemoActions {
  reset: () => Promise<void>;
  setClock: (hhmm: string) => Promise<void>;
  /** Point the map (not the clock) at a time of day; null = follow the clock. */
  showMapAt: (hhmm: string | null) => Promise<void>;
  plan: (origin: string, destination: string, arriveBy: string, safe: boolean) => Promise<void>;
  saveTrip: () => Promise<void>;
  block: (crossingId: string, minutes: number) => Promise<void>;
  clearBlockages: () => Promise<void>;
}

interface Step {
  title: string;
  narration: string;
  run: (a: DemoActions) => Promise<void>;
}

const STEPS: Step[] = [
  {
    title: "Monday, 7:05 AM in Houston",
    narration:
      "Rush hour is building. The colors are predicted congestion, learned from 8 weeks of history per road and per 15 minutes, not just what's jammed right now.",
    run: async (a) => {
      await a.reset();
      await a.setClock("07:05");
    },
  },
  {
    title: "East End → Medical Center, arrive by 8:00",
    narration:
      "A traffic-only app sends you down Cullen Blvd. A freight train crosses there almost every weekday around 7:40, so we route around it and tell you exactly when to leave.",
    run: async (a) => {
      await a.plan("eastend", "medcenter", "08:00", false);
      await a.showMapAt("07:40"); // show crossing predictions when you'd reach them
    },
  },
  {
    title: "Watch this commute",
    narration: "Save it once and the app watches it every weekday, pushing a plan, live updates and a “leave now” alert.",
    run: (a) => a.saveTrip(),
  },
  {
    title: "Live: a freight train stops on Old Spanish Trail",
    narration: "A train just parked across your route. The app reroutes you before you ever reach it, and says why.",
    run: async (a) => {
      await a.showMapAt(null);
      await a.block("x_ost", 60);
      await a.plan("eastend", "medcenter", "08:00", false);
    },
  },
  {
    title: "7:35 AM: time to go",
    narration: "Right on time, the “leave now” alert arrives with the route to take.",
    run: (a) => a.setClock("07:35"),
  },
  {
    title: "Evening: Downtown → Hobby Airport by 5:45",
    narration: "The fastest way is the I-45 Gulf Freeway, one of the most crash-prone stretches in our data at rush hour.",
    run: async (a) => {
      await a.clearBlockages();
      await a.setClock("16:40");
      await a.plan("downtown", "hobby", "17:45", false);
      await a.showMapAt("17:15");
    },
  },
  {
    title: "Flip on Safe Path 🛡️",
    narration: "Safe Path trades a few minutes for a route that skips the crash-prone stretch of the Gulf Freeway.",
    run: (a) => a.plan("downtown", "hobby", "17:45", true),
  },
  {
    title: "That's the idea",
    narration:
      "Train-aware, crash-aware, leave-time alerts built for Houston. Real TranStar, TrainWatch and Bluetooth sensor feeds plug into the same interfaces.",
    run: async () => {},
  },
];

export default function DemoRunner({ actions, onExit }: { actions: DemoActions; onExit: () => void }) {
  const [index, setIndex] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go(i: number) {
    setBusy(true);
    setError(null);
    try {
      await STEPS[i].run(actions);
      setIndex(i);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const step = index >= 0 ? STEPS[index] : null;
  const last = index === STEPS.length - 1;

  return (
    <div className="fixed bottom-20 left-1/2 z-[1100] w-[min(94vw,560px)] -translate-x-1/2 rounded-2xl bg-slate-900 p-4 text-white shadow-2xl">
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span>Demo {step ? `· step ${index + 1} of ${STEPS.length}` : ""}</span>
        <button onClick={onExit} className="hover:text-white">
          Exit ✕
        </button>
      </div>
      <h3 className="mt-1 text-lg font-semibold">{step ? step.title : "Scripted demo"}</h3>
      <p className="mt-1 text-sm text-slate-300">
        {step ? step.narration : "Walks through a Monday commute: predicted trains, a live blockage, the leave-now alert and Safe Path."}
      </p>
      {error && <p className="mt-2 rounded bg-red-900/60 p-2 text-sm">Backend error: {error}. Is the API running on :8000?</p>}
      <div className="mt-3 flex justify-end gap-2">
        {index > 0 && (
          <button onClick={() => go(0)} disabled={busy} className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm">
            Restart
          </button>
        )}
        <button
          onClick={() => (last ? onExit() : go(index + 1))}
          disabled={busy}
          className="rounded-lg bg-blue-500 px-4 py-1.5 text-sm font-semibold disabled:opacity-60"
        >
          {busy ? "…" : index < 0 ? "Start" : last ? "Done" : "Next →"}
        </button>
      </div>
    </div>
  );
}
