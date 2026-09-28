"use client";

/** Floating map controls: legend, zoom, the layers menu (map details, nearby places, the theme) and the Live cams button. */

import { useState } from "react";

import { useApp } from "@/components/app/AppContext";
import ThemeSetting from "@/components/app/ThemeSetting";
import NearbyMenu from "@/components/places/NearbyMenu";
import ReportButton from "@/components/reports/ReportButton";
import { Icon, RoundButton } from "@/components/ui";
import { C, ICON } from "@/lib/theme";

export function Legend() {
  const { mapTime } = useApp();
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl bg-float px-3 py-2 text-[12px] font-medium text-soft shadow-e1"
    >
      {/* Each swatch stays with its label when a narrow legend wraps */}
      {[
        [C.light, "Light"],
        [C.moderate, "Moderate"],
        [C.heavy, "Heavy"],
      ].map(([color, label]) => (
        <span key={label} className="flex items-center gap-1.5">
          <span className="h-[5px] w-[18px] rounded-[3px]" style={{ background: color }} />
          <span>{label}</span>
        </span>
      ))}
      {mapTime && <span className="text-accent">· predicted</span>}
    </div>
  );
}

export function ZoomButtons() {
  const { zoom } = useApp();
  return (
    <div className="flex flex-col overflow-hidden rounded-xl bg-float shadow-e1">
      <button type="button" aria-label="Zoom in" onClick={() => zoom(1)} className="flex h-11 w-11 cursor-pointer items-center justify-center text-soft hover:bg-card">
        <Icon d={ICON.plus} size={20} />
      </button>
      <div className="mx-2 h-px bg-line" />
      <button type="button" aria-label="Zoom out" onClick={() => zoom(-1)} className="flex h-11 w-11 cursor-pointer items-center justify-center text-soft hover:bg-card">
        <Icon d={ICON.minus} size={20} />
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
          className="fade-in absolute top-14 right-0 z-[1200] w-56 rounded-[12px] bg-pop p-2 shadow-e2"
        >
          <span className="block px-2 pt-1 pb-0.5 text-[12px] font-semibold text-muted">Map details</span>
          {rows.map(([k, label]) => (
            <label key={k} className="flex cursor-pointer items-center justify-between rounded-lg px-2 py-2 text-[14px] hover:bg-card">
              {label}
              <input type="checkbox" checked={layers[k]} onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })} />
            </label>
          ))}
          <NearbyMenu onDone={() => setOpen(false)} />
          <div className="mt-1 border-t border-pop-line pt-2">
            <ThemeSetting />
          </div>
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
      className="flex h-12 cursor-pointer items-center gap-2 rounded-3xl pr-4 pl-3 text-[14px] font-semibold shadow-e1"
      style={{ background: C.accent, color: C.onAccent }}
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
      <div className="pointer-events-auto absolute bottom-6 left-4 z-[900]">
        <ReportButton />
      </div>
    </>
  );
}
