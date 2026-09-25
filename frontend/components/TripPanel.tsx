"use client";

import { fmtTime, pct } from "@/lib/format";
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
  safe: boolean;
  setSafe: (v: boolean) => void;
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
  if (reason.startsWith("Safe Path")) return "🛡️";
  if (reason.startsWith("About")) return "⏱️";
  return "⚠️";
}

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
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Arrive by</span>
          <input
            type="time"
            value={p.arriveBy}
            onChange={(e) => p.setArriveBy(e.target.value)}
            className="mt-1 block rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
          />
        </label>
        <label className="flex cursor-pointer items-center gap-2 pb-2 text-sm">
          <span
            role="switch"
            aria-checked={p.safe}
            onClick={() => p.setSafe(!p.safe)}
            className={`relative inline-block h-5 w-9 rounded-full transition ${p.safe ? "bg-violet-600" : "bg-slate-300"}`}
          >
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${p.safe ? "left-4" : "left-0.5"}`} />
          </span>
          🛡️ Safe Path
        </label>
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
          <div className="text-4xl font-bold text-slate-900">{fmtTime(r.depart_at)}</div>
          <div className="mt-1 text-sm text-slate-600">
            Arrive {fmtTime(r.eta)} · {r.route.total_min} min ·{" "}
            <span
              className={
                r.confidence_label === "high" ? "text-green-700" : r.confidence_label === "medium" ? "text-amber-700" : "text-red-700"
              }
            >
              {r.confidence_label} confidence ({pct(r.confidence)})
            </span>
          </div>
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
