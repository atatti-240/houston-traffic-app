/**
 * What driving mode says, and when: each turn about a minute ahead ("In half a mile, turn left onto Westheimer Rd")
 * and again as you reach it ("Turn left onto Westheimer Rd"), a heads-up for trains, closures, incidents and driver
 * reports ahead, and arrival. Every call has a key; the caller remembers the keys it said, so nothing repeats.
 * No framework imports (unit-tested with `node --test`).
 */

import type { CourseStep, Hazard, Progress } from "./course.ts";

export interface Say {
  key: string;
  text: string;
  /** Say it before anything waiting (a turn you're about to reach) */
  urgent?: boolean;
  /** A newer call in the same group replaces one still waiting to be said */
  group?: string;
  /** Keys this call covers too (a "then" turn, the early call for a turn called at the last moment) */
  covers?: string[];
}

/** An assumed speed when the fix has none, m/s (about 30 mph) */
const DEFAULT_SPEED = 13.4;
/** Two turns this close together are said as one: "Turn left, then turn right" */
const THEN_M = 150;
/** An early call this close to the turn call (times `near`) is skipped */
const SOON_ENOUGH = 1.6;
/** Say how long a stretch is when the next turn is this much farther than the early call */
const LONG_M = 1600;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Early calls happen at these distances (a quarter, half and whole mile), so what's said is what's left. */
const EARLY_M = [402, 805, 1609];

/** How far ahead to call a turn: `far` up to a minute ahead (a quarter mile in town, a mile on the freeway), `near`
 * about 7 s ahead. */
export function leadDistances(speedMps: number | null | undefined): { far: number; near: number } {
  const v = Math.max(speedMps && Number.isFinite(speedMps) ? speedMps : DEFAULT_SPEED, 8);
  const want = v * 60;
  const far = EARLY_M.filter((m) => m <= want).pop() ?? EARLY_M[0];
  return { far, near: clamp(v * 7, 45, 250) };
}

/** A distance as it's said: "300 feet", "a quarter mile", "half a mile", "1 mile", "3 miles". */
export function spokenDistance(m: number): string {
  const mi = m / 1609.344;
  const ft = m * 3.28084;
  if (ft < 1000) {
    const step = ft < 300 ? 50 : 100;
    return `${Math.max(50, Math.round(ft / step) * step)} feet`;
  }
  if (mi < 0.37) return "a quarter mile";
  if (mi < 0.62) return "half a mile";
  if (mi < 0.87) return "three quarters of a mile";
  if (mi < 1.25) return "1 mile";
  if (mi < 1.75) return "1.5 miles";
  return `${Math.round(mi)} miles`;
}

const lower = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);

/** "On the left" from an arrive instruction ("Arrive at your destination, on the left"). */
function arriveSide(step: CourseStep["step"]): string {
  const m = /on the (left|right)$/.exec(step.instruction);
  return m ? `on the ${m[1]}` : "ahead";
}

/**
 * Turn calls due now. `prefix` makes the keys unique to this course (a re-plan starts over); `toName`: the
 * destination as it's said ("The Galleria").
 */
export function turnCalls(
  steps: CourseStep[],
  p: Pick<Progress, "along" | "next" | "toNext">,
  speedMps: number | null | undefined,
  said: ReadonlySet<string>,
  prefix: string,
  toName = "",
): Say[] {
  if (p.next === null || !steps[p.next]) return [];
  const n = p.next;
  const cur = steps[n];
  const d = p.toNext;
  const { far, near } = leadDistances(speedMps);
  const key = (i: number, stage: string) => `${prefix}${i}:${stage}`;
  const arrive = cur.step.maneuver.type === "arrive";
  const place = toName || "your destination";

  if (d <= near) {
    // Arriving is said by the arrival itself
    if (arrive || said.has(key(n, "now"))) return [];
    let text = cur.step.instruction;
    const covers = [key(n, "soon")];
    const after = steps[n + 1];
    if (after && after.along - cur.along <= THEN_M) {
      text +=
        after.step.maneuver.type === "arrive"
          ? `, then ${place} is ${arriveSide(after.step)}`
          : `, then ${lower(after.step.instruction)}`;
      covers.push(key(n + 1, "soon"));
    }
    return [{ key: key(n, "now"), text, urgent: true, group: "turn", covers }];
  }
  if (d <= far) {
    if (said.has(key(n, "soon")) || said.has(key(n, "now"))) return [];
    // Only just past the last turn and this one is already close: one call as you reach it, not two in a row
    if (d <= near * SOON_ENOUGH) return [];
    const text = arrive
      ? `In ${spokenDistance(d)}, ${place} is ${arriveSide(cur.step)}`
      : `In ${spokenDistance(d)}, ${lower(cur.step.instruction)}`;
    return [{ key: key(n, "soon"), text, group: "turn" }];
  }
  // A long stretch right after a turn: say how long ("Continue on I-69 for 5 miles")
  const prev = steps[n - 1];
  if (prev && p.along - prev.along < 300 && d > far + LONG_M && !said.has(key(n, "long"))) {
    const road = prev.step.road;
    return [{ key: key(n, "long"), text: `Continue${road ? ` on ${road}` : ""} for ${spokenDistance(d)}`, group: "turn" }];
  }
  return [];
}

/** The heads-up for one hazard `d` meters ahead. */
export function hazardText(h: Hazard, d: number): string {
  const inD = `in ${spokenDistance(d)}`;
  const on = h.road ? ` on ${h.road}` : "";
  const lanes = h.lanesBlocked > 0 ? ` ${h.lanesBlocked} lane${h.lanesBlocked > 1 ? "s" : ""} blocked.` : "";
  switch (h.kind) {
    case "train":
      if (h.blocked)
        return `A train is blocking the crossing${on}, ${inD}.${h.clearsInMin ? ` It should clear in about ${Math.max(1, Math.round(h.clearsInMin))} minutes.` : ""}`;
      return `Rail crossing${on} ${inD}. Trains often block it around now.`;
    case "closure":
      return `Road closure${on} ${inD}.`;
    case "report":
      return `Reported by drivers: ${lower(h.title)}${on}, ${inD}.${lanes}`;
    default:
      return `Heads up: ${lower(h.title)}${on}, ${inD}.${lanes}`;
  }
}

/** Heads-ups due now: each hazard once, about a minute ahead (at least half a mile). Keys don't depend on the
 * course, so a re-plan doesn't repeat them. */
export function hazardCalls(list: Hazard[], along: number, speedMps: number | null | undefined, said: ReadonlySet<string>): Say[] {
  const v = Math.max(speedMps && Number.isFinite(speedMps) ? speedMps : DEFAULT_SPEED, 8);
  const lead = clamp(v * 60, 800, 2400);
  const out: Say[] = [];
  for (const h of list) {
    const d = h.along - along;
    if (d < 0 || d > lead) continue;
    const key = `hazard:${h.key}`;
    if (said.has(key)) continue;
    out.push({ key, text: hazardText(h, d), group: key });
  }
  return out;
}

/** The first hazard ahead within `within` meters (for the banner). */
export function nextHazard(list: Hazard[], along: number, within = 3200): { hazard: Hazard; distance: number } | null {
  for (const h of list) {
    const d = h.along - along;
    if (d >= 0 && d <= within) return { hazard: h, distance: d };
  }
  return null;
}
