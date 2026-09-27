"use client";

/** A US speed limit sign (white, black border, SPEED / LIMIT over the number), drawn so it reads
 * at a glance on the dark UI. `mini` is just the bordered number, for a line of text. An unknown
 * limit is a grey outline with a "?", and says so to screen readers. */

import { C } from "@/lib/theme";

const INK = C.onAccent;
const FONT = "var(--font-plex-mono), IBM Plex Mono, monospace";

export function SpeedLimitSign({ mph, size = 44, mini = false }: { mph: number | null | undefined; size?: number; mini?: boolean }) {
  const known = typeof mph === "number";
  const label = known ? `Speed limit ${mph} mph` : "Speed limit not known";
  const fill = known ? C.marker : "none";
  const ink = known ? INK : C.muted;
  const edge = known ? INK : C.edgeStrong;
  if (mini)
    return (
      <svg width={size} height={size * 1.2} viewBox="0 0 20 24" role="img" aria-label={label} className="shrink-0">
        <rect x="0.5" y="0.5" width="19" height="23" rx="3" fill={fill} stroke={known ? "none" : edge} />
        <rect x="2" y="2" width="16" height="20" rx="1.8" fill="none" stroke={edge} strokeWidth="1.2" />
        <text x="10" y="16.2" textAnchor="middle" fontFamily={FONT} fontSize="10" fontWeight="700" fill={ink}>
          {known ? mph : "?"}
        </text>
      </svg>
    );
  return (
    <svg width={size} height={size * 1.25} viewBox="0 0 40 50" role="img" aria-label={label} className="shrink-0">
      <rect x="0.5" y="0.5" width="39" height="49" rx="5" fill={fill} stroke={known ? "none" : edge} />
      <rect x="2.5" y="2.5" width="35" height="45" rx="3.5" fill="none" stroke={edge} strokeWidth="1.6" />
      <text x="20" y="12.5" textAnchor="middle" fontSize="7.2" fontWeight="700" letterSpacing="0.3" fill={ink}>
        SPEED
      </text>
      <text x="20" y="20.5" textAnchor="middle" fontSize="7.2" fontWeight="700" letterSpacing="0.3" fill={ink}>
        LIMIT
      </text>
      <text x="20" y="41" textAnchor="middle" fontFamily={FONT} fontSize={known && mph >= 100 ? 15 : 19} fontWeight="700" fill={ink}>
        {known ? mph : "?"}
      </text>
    </svg>
  );
}
