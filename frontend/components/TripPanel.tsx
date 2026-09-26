"use client";

import { fmtDayTime, fmtTime, pct } from "@/lib/format";
import type { Location, Place, Recommendation } from "@/lib/types";

import type { Layers } from "./MapView";

export type PickMode = "origin" | "destination" | null;

interface Props {
  places: Place[];
  origin: Location | null;
  destination: Location | null;
  setOrigin: (l: Location) => void;
  setDestination: (l: Location) => void;
  arriveBy: string;
  setArriveBy: (v: string) => void;
  /** 0 = fastest, 1 = safest */
  safety: number;
  setSafety: (v: number) => void;
  pickMode: PickMode;
  setPickMode: (m: PickMode) => void;
  onPlan: () => void;
  onSave: () => void;
  loading: boolean;
  error: string | null;
  rec: Recommendation | null;
  showAlt: boolean;
  setShowAlt: (v: boolean) => void;
  layers: Layers;
  setLayers: (l: Layers) => void;
  saved: boolean;
  clockNow: string | null;
}

function locLabel(loc: Location | null, places: Place[]): string {
  if (!loc) return "";
  if (typeof loc === "string") return places.find((p) => p.id === loc)?.name ?? loc;
  return `📍 ${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}`;
}

function PlaceField(props: {
  label: string;
  value: Location | null;
  places: Place[];
  onChange: (l: Location) => void;
  picking: boolean;
  onPick: () => void;
}) {
  const selected = typeof props.value === "string" ? props.value : "";
  return (
    <label className="block">
      <span className="text-xs font-medium uppercase tracking-wide text-slate-500">{props.label}</span>
      <div className="mt-1 flex gap-2">
        <select
          className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm"
          value={selected}
          onChange={(e) => props.onChange(e.target.value)}
        >
          {!selected && <option value="">{props.value ? locLabel(props.value, props.places) : "Choose a place…"}</option>}
          {props.places.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={props.onPick}
          className={`rounded-lg border px-2 text-sm ${props.picking ? "border-blue-600 bg-blue-600 text-white" : "border-slate-300 bg-white"}`}
          title="Pick on map"
        >
          📍
        </button>
      </div>
    </label>
  );
}

function reasonIcon(reason: string): string {
  if (reason.startsWith("Avoided") || reason.startsWith("Rerouted")) return "✅";
  if (reason.startsWith("Safe Path") || reason.startsWith("Safety setting")) return "🛡️";
  if (reason.startsWith("About")) return "⏱️";
  if (reason.includes("unavailable")) return "📡";
  return "⚠️";
}

const SAFETY_LABELS = ["Fastest", "Mostly fast", "Balanced", "Mostly safe", "Safest"];

export function safetyLabel(w: number): string {
  return SAFETY_LABELS[Math.round(Math.max(0, Math.min(1, w)) * 4)];
}

function SafetySlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <div className="flex items-center justify-between text-xs font-medium uppercase tracking-wide text-slate-500">
        <span>Route</span>
        <span className={value > 0 ? "text-violet-700" : "text-slate-600"}>
          {value > 0 ? "🛡️ " : ""}
          {safetyLabel(value)}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.25}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="Faster or safer route"
        aria-valuetext={safetyLabel(value)}
        className="mt-1 w-full accent-violet-600"
      />
      <div className="flex justify-between text-[11px] text-slate-500">
        <span>Faster</span>
        <span>Safer (fewer crash-prone roads)</span>
      </div>
    </label>
  );
}

const CONF_TONE = { high: "text-green-700", medium: "text-amber-700", low: "text-red-700" } as const;

export default function TripPanel(p: Props) {
  const r = p.rec;
  return (
    <div className="flex flex-col gap-3">
      <PlaceField
        label="From"
        value={p.origin}
        places={p.places}
        onChange={p.setOrigin}
        picking={p.pickMode === "origin"}
        onPick={() => p.setPickMode(p.pickMode === "origin" ? null : "origin")}
      />
      <PlaceField
        label="To"
        value={p.destination}
        places={p.places}
        onChange={p.setDestination}
        picking={p.pickMode === "destination"}
        onPick={() => p.setPickMode(p.pickMode === "destination" ? null : "destination")}
      />
      {p.pickMode && <p className="text-xs text-blue-700">Click the map to set the {p.pickMode}.</p>}

      <div className="flex items-end gap-3">
        <label className="block shrink-0">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Arrive by</span>
          <input
            type="time"
            value={p.arriveBy}
            onChange={(e) => p.setArriveBy(e.target.value)}
            className="mt-1 block rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
          />
        </label>
        <div className="min-w-0 flex-1">
          <SafetySlider value={p.safety} onChange={p.setSafety} />
        </div>
      </div>

      <button
        onClick={p.onPlan}
        disabled={!p.origin || !p.destination || p.loading}
        className="rounded-lg bg-blue-600 py-2 font-semibold text-white shadow disabled:opacity-50"
      >
        {p.loading ? "Planning…" : "Plan my trip"}
      </button>
      {p.error && <p className="rounded bg-red-50 p-2 text-sm text-red-700">{p.error}</p>}

      {r && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="text-xs uppercase tracking-wide text-slate-500">{r.on_time ? "Leave at" : "Leave now, you'll be late"}</div>
          <div className="text-4xl font-bold text-slate-900">
            {p.clockNow && r.depart_at.slice(0, 10) !== p.clockNow.slice(0, 10) ? fmtDayTime(r.depart_at) : fmtTime(r.depart_at)}
          </div>
          <div className="mt-1 text-sm text-slate-600">
            Arrive {fmtTime(r.eta)} · {r.route.total_min} min ·{" "}
            <span className={CONF_TONE[r.confidence_label]}>
              {r.confidence_label} confidence ({pct(r.confidence)})
            </span>
          </div>
          {r.leave_at_safe !== r.depart_at && (
            <div className="mt-0.5 text-xs text-slate-500">
              Can&apos;t be late? Leave by {fmtTime(r.leave_at_safe)}
              {r.data_confidence !== "high" ? " (this route leans on predictions)" : ""}.
            </div>
          )}
          {r.route.feeds_down.length > 0 && (
            <div className="mt-1 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
              📡 Live {r.route.feeds_down.join(", ")} data is down; using predictions.
            </div>
          )}
          <div className="mt-2 text-sm font-medium text-slate-800">{r.route.summary}</div>

          {r.route.reasons.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm">
              {r.route.reasons.map((reason) => (
                <li key={reason} className="flex gap-2">
                  <span>{reasonIcon(reason)}</span>
                  <span>{reason}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
            <div className="rounded bg-white p-1.5">
              <div className="font-semibold">{r.route.breakdown.base_travel_min}m</div>
              <div className="text-slate-500">driving</div>
            </div>
            <div className="rounded bg-white p-1.5">
              <div className="font-semibold">{r.route.breakdown.train_delay_min}m</div>
              <div className="text-slate-500">train risk</div>
            </div>
            <div className="rounded bg-white p-1.5">
              <div className="font-semibold">{pct(r.route.breakdown.max_crash_risk)}</div>
              <div className="text-slate-500">peak crash risk</div>
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between gap-2">
            {r.alternative ? (
              <label className="flex items-center gap-1.5 text-xs text-slate-600">
                <input type="checkbox" checked={p.showAlt} onChange={(e) => p.setShowAlt(e.target.checked)} />
                Show alternative ({r.alternative.total_min} min)
              </label>
            ) : (
              <span />
            )}
            <button
              onClick={p.onSave}
              disabled={p.saved}
              className="rounded-lg border border-blue-600 px-2 py-1 text-xs font-semibold text-blue-700 disabled:border-green-600 disabled:text-green-700"
            >
              {p.saved ? "✓ Watching weekdays" : "🔔 Alert me on weekdays"}
            </button>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-slate-200 p-3">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Map layers</div>
        <div className="grid grid-cols-2 gap-1.5 text-sm">
          {(
            [
              ["congestion", "🚦 Congestion"],
              ["crash", "💥 Crash risk"],
              ["trains", "🚆 Rail crossings"],
              ["incidents", "🚧 Incidents"],
              ["cameras", "📷 Cameras"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex items-center gap-1.5">
              <input type="checkbox" checked={p.layers[key]} onChange={(e) => p.setLayers({ ...p.layers, [key]: e.target.checked })} />
              {label}
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
