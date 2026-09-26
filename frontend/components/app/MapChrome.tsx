"use client";

/** Floating map controls from the design: legend, zoom, layers menu and the Live cams button. */

import { useState } from "react";

import { useApp } from "@/components/app/AppContext";
import { Icon, RoundButton } from "@/components/ui";
import { C, ICON } from "@/lib/theme";

export function Legend() {
  const { mapTime } = useApp();
  return (
    <div
      className="flex items-center gap-1.5 rounded-xl border border-edge px-3 py-2 text-[12px] font-medium text-soft"
      style={{ background: "rgba(30,34,43,0.95)", boxShadow: "0 1px 8px rgba(0,0,0,0.4)" }}
    >
      <span className="h-[5px] w-[18px] rounded-[3px]" style={{ background: C.light }} />
      <span>Light</span>
      <span className="ml-1.5 h-[5px] w-[18px] rounded-[3px]" style={{ background: C.moderate }} />
      <span>Moderate</span>
      <span className="ml-1.5 h-[5px] w-[18px] rounded-[3px]" style={{ background: C.heavy }} />
      <span>Heavy</span>
      {mapTime && <span className="ml-1.5 text-accent">· predicted</span>}
    </div>
  );
}

export function ZoomButtons() {
  const { zoom } = useApp();
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-edge bg-card" style={{ boxShadow: "0 1px 8px rgba(0,0,0,0.4)" }}>
      <button type="button" aria-label="Zoom in" onClick={() => zoom(1)} className="h-11 w-11 cursor-pointer text-[20px] text-ink">
        +
      </button>
      <div className="h-px bg-edge" />
      <button type="button" aria-label="Zoom out" onClick={() => zoom(-1)} className="h-11 w-11 cursor-pointer text-[20px] text-ink">
        −
      </button>
    </div>
  );
}

export function LayersButton() {
  const { layers, setLayers } = useApp();
  const [open, setOpen] = useState(false);
  const rows: [keyof typeof layers, string][] = [
    ["causes", "Causes"],
    ["cameras", "Cameras"],
    ["crossings", "Rail crossings"],
  ];
  return (
    <div className="relative">
      <RoundButton label="Map layers" onClick={() => setOpen(!open)} active={open}>
        <Icon d={ICON.layers} size={20} />
      </RoundButton>
      {open && (
        <div
          className="fade-in absolute top-14 right-0 z-[1200] w-48 rounded-[14px] border border-pop-line bg-pop p-2"
          style={{ boxShadow: "0 10px 32px rgba(0,0,0,0.6)" }}
        >
          {rows.map(([k, label]) => (
            <label key={k} className="flex cursor-pointer items-center justify-between rounded-lg px-2 py-2 text-[14px] hover:bg-card">
              {label}
              <input type="checkbox" checked={layers[k]} onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })} />
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export function LiveCamsButton() {
  const { go } = useApp();
  return (
    <button
      type="button"
      onClick={() => go({ name: "cameras" })}
      aria-label="Live cameras: watch a road or area"
      className="flex h-12 cursor-pointer items-center gap-2 rounded-3xl pr-4 pl-3 text-[14px] font-semibold"
      style={{ background: C.accent, color: C.onAccent, boxShadow: "0 4px 16px rgba(0,0,0,0.55)" }}
    >
      <Icon d={ICON.camera} color={C.onAccent} />
      Live cams
    </button>
  );
}

/** Desktop: all controls over the map area. */
export default function MapChrome() {
  const { screen } = useApp();
  return (
    <>
      <div className="pointer-events-auto absolute top-4 left-4 z-[900]">
        <Legend />
      </div>
      <div className="pointer-events-auto absolute top-4 right-4 z-[900] flex flex-col items-end gap-2.5">
        <LayersButton />
        <ZoomButtons />
      </div>
      {screen.name !== "cameras" && (
        <div className="pointer-events-auto absolute right-4 bottom-6 z-[900]">
          <LiveCamsButton />
        </div>
      )}
    </>
  );
}
