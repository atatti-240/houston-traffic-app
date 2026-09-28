"use client";

/** The map's locate button: center on you and follow as you move (filled while following; drag the map to stop).
 * While driving it is driving mode's Recenter (one follow at a time). */

import { locateMe, useFollow, useLiveStatus } from "@/components/app/liveLocation";
import { drive, useDrive } from "@/components/drive/store";
import { C } from "@/lib/theme";

export default function LocateButton() {
  const { on: following } = useFollow();
  const driving = useDrive((s) => s.active);
  const driveFollow = useDrive((s) => s.follow);
  const on = driving ? driveFollow : following;
  const status = useLiveStatus();
  const off = status === "denied" || status === "unavailable";
  return (
    <button
      type="button"
      aria-label={off ? "Center on the default spot (location is off)" : on ? "Following you: tap to recenter" : "Center on my location"}
      aria-pressed={on}
      title={off ? "Location is off" : undefined}
      onClick={driving ? drive.recenter : locateMe}
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
