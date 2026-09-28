"use client";

/** The "Nearby" part of the map's layers menu: gas / EV chargers / parking highlights on the map,
 * and the "Gas near me" list. */

import { useApp } from "@/components/app/AppContext";

import { MIN_ZOOM } from "./poiLayers";
import { POI, POI_KINDS } from "./pois";
import { setPoiLayer, useMapZoom, usePoiLayers, usePoiStatus } from "./store";

export default function NearbyMenu({ onDone }: { onDone: () => void }) {
  const { zoom, go } = useApp();
  const on = usePoiLayers();
  const z = useMapZoom();
  const status = usePoiStatus();
  const any = POI_KINDS.some((k) => on[k]);
  return (
    <div className="mt-1 flex flex-col border-t border-pop-line pt-1.5">
      <span className="px-2 pt-1 pb-0.5 text-[12px] font-semibold text-muted">Nearby</span>
      {POI_KINDS.map((k) => (
        <label key={k} className="flex cursor-pointer items-center justify-between rounded-lg px-2 py-2 text-[14px] hover:bg-card">
          <span className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: POI[k].color }} aria-hidden="true" />
            {POI[k].label}
          </span>
          <input
            type="checkbox"
            checked={on[k]}
            onChange={(e) => {
              setPoiLayer(k, e.target.checked);
              // They only show from street level: take the map there.
              if (e.target.checked && z < MIN_ZOOM) zoom(MIN_ZOOM - z);
            }}
          />
        </label>
      ))}
      {any && status !== "ok" && (
        <span className="px-2 pb-1 text-[12px] leading-snug text-muted">
          {status === "failed" ? "Couldn't load them right now." : "Zoom in to see them on the map."}
        </span>
      )}
      <button
        type="button"
        onClick={() => {
          onDone();
          go({ name: "nearby", kind: "fuel" });
        }}
        className="mt-0.5 cursor-pointer rounded-lg px-2 py-2 text-left text-[14px] font-medium text-accent hover:bg-card"
      >
        Gas near me →
      </button>
    </div>
  );
}
