"use client";

import { parseSim, toSimIso } from "@/lib/format";

interface Props {
  clockNow: string | null;
  mapTime: string | null; // null = follow the live (simulated) clock
  setMapTime: (iso: string | null) => void;
}

const SLOTS = 96;

export default function TimeSlider({ clockNow, mapTime, setMapTime }: Props) {
  if (!clockNow) return null;
  const base = parseSim(clockNow);
  const shown = parseSim(mapTime ?? clockNow);
  const slot = shown.getHours() * 4 + Math.floor(shown.getMinutes() / 15);
  const label = shown.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  function onSlide(v: number) {
    const d = new Date(base);
    d.setHours(Math.floor(v / 4), (v % 4) * 15, 0, 0);
    setMapTime(toSimIso(d));
  }

  return (
    <div className="flex items-center gap-3 rounded-xl bg-white/95 px-3 py-2 shadow-lg backdrop-blur">
      <div className="w-28 shrink-0 text-sm">
        <div className="text-[10px] uppercase tracking-wide text-slate-500">{mapTime ? "Map time" : "Live"}</div>
        <div className="font-semibold">
          {shown.toLocaleDateString([], { weekday: "short" })} {label}
        </div>
      </div>
      <input
        type="range"
        min={0}
        max={SLOTS - 1}
        value={slot}
        onChange={(e) => onSlide(Number(e.target.value))}
        className="w-full accent-blue-600"
        aria-label="Scrub the map through the day"
      />
      <button
        onClick={() => setMapTime(null)}
        disabled={!mapTime}
        className="shrink-0 rounded-lg border border-slate-300 px-2 py-1 text-xs disabled:opacity-40"
      >
        Now
      </button>
    </div>
  );
}
