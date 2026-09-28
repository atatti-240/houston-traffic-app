"use client";

/** The map's locate button: center on you and follow as you move (filled while following; drag the map to stop). */

import { locateMe, useFollow, useLiveStatus } from "@/components/app/liveLocation";
import { C } from "@/lib/theme";

export default function LocateButton() {
  const { on } = useFollow();
  const status = useLiveStatus();
  const off = status === "denied" || status === "unavailable";
  return (
    <button
      type="button"
      aria-label={off ? "Center on the default spot (location is off)" : on ? "Following you: tap to recenter" : "Center on my location"}
      aria-pressed={on}
      title={off ? "Location is off" : undefined}
      onClick={locateMe}
      className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-xl bg-float shadow-e1 hover:bg-card"
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke={off ? C.muted : C.accent}
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="6" fill={on ? C.accent : "none"} />
        {!on && <circle cx="12" cy="12" r="1.5" fill={off ? C.muted : C.accent} />}
        <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
      </svg>
    </button>
  );
}
