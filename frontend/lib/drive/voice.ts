/**
 * What driving mode says, and when: each turn about a minute ahead ("In half a mile, turn left onto Westheimer Rd")
 * and again as you reach it ("Turn left onto Westheimer Rd"); exits, ramps, forks and merges (and anything at freeway
 * speed) also a quarter mile ahead, to change lanes in time. A road that only changes its name needs nothing from
 * you: it's said once as you reach it, never cutting anything short. A heads-up for trains, closures, incidents and
 * driver reports ahead (and on the road you're already on), and arrival. Every call has a key; the caller remembers
 * the keys it said, so nothing repeats. `forSpeech` makes the text read well aloud.
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
export const SOON_ENOUGH = 1.6;
/** Say how long a stretch is when the next turn is this much farther than the early call */
const LONG_M = 1600;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Early calls happen at these distances (a quarter, half and whole mile), so what's said is what's left. */
const EARLY_M = [402, 805, 1609];
const QUARTER_M = EARLY_M[0];
/** Maneuvers that need a lane change ahead of time */
const HIGHWAY = new Set(["off ramp", "on ramp", "fork", "merge"]);
/** Faster than this (m/s, about 45 mph) every maneuver gets the quarter-mile call */
const FAST_MPS = 20;

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

/** A step that needs nothing from the driver: the road changes its name, goes on straight, or leaves a roundabout
 * (its entry already said which exit). */
export function passive(step: CourseStep["step"]): boolean {
  const { type, modifier: mod } = step.maneuver;
  if (type === "new name" || type === "exit roundabout" || type === "exit rotary") return true;
  return (type === "continue" || type === "turn") && (!mod || mod === "straight");
}

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
  const quiet = !arrive && passive(cur.step);
  const highway = !arrive && (HIGHWAY.has(cur.step.maneuver.type) || (speedMps ?? 0) > FAST_MPS);
  const place = toName || "your destination";

  if (d <= near) {
    // Arriving is said by the arrival itself
    if (arrive || said.has(key(n, "now"))) return [];
    let text = cur.step.instruction;
    const covers = [key(n, "soon"), key(n, "quarter")];
    const after = steps[n + 1];
    if (after && after.along - cur.along <= THEN_M) {
      text +=
        after.step.maneuver.type === "arrive"
          ? `, then ${place} is ${arriveSide(after.step)}`
          : `, then ${lower(after.step.instruction)}`;
      covers.push(key(n + 1, "soon"), key(n + 1, "quarter"));
    }
    // Nothing to do (a new name): it waits its turn instead of cutting a heads-up short
    return [{ key: key(n, "now"), text, urgent: !quiet, group: "turn", covers }];
  }
  // Nothing to get ready for: no early call
  if (quiet && d <= far) return [];
  if (highway && far > QUARTER_M && d <= QUARTER_M) {
    if (said.has(key(n, "quarter")) || said.has(key(n, "now"))) return [];
    if (d <= near * SOON_ENOUGH) return [];
    return [{ key: key(n, "quarter"), text: `In ${spokenDistance(d)}, ${lower(cur.step.instruction)}`, group: "turn", covers: [key(n, "soon")] }];
  }
  if (d <= far) {
    if (said.has(key(n, "soon")) || said.has(key(n, "quarter")) || said.has(key(n, "now"))) return [];
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

/**
 * What's next, said on demand (voice turned back on, or a new route): "In 2 miles, turn right onto Main St". It
 * covers that turn's early calls. Null when there's no turn left.
 */
export function nextCall(steps: CourseStep[], p: Pick<Progress, "along" | "next" | "toNext">, prefix: string, toName = ""): Say | null {
  if (p.next === null || !steps[p.next]) return null;
  const n = p.next;
  const cur = steps[n];
  const d = spokenDistance(p.toNext);
  const text =
    cur.step.maneuver.type === "arrive" ? `In ${d}, ${toName || "your destination"} is ${arriveSide(cur.step)}` : `In ${d}, ${lower(cur.step.instruction)}`;
  return { key: `${prefix}${n}:again@${Math.round(p.along)}`, text, group: "turn", covers: [`${prefix}${n}:soon`, `${prefix}${n}:quarter`, `${prefix}${n}:long`] };
}

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Report titles that read without "a": "Drivers report police on ..." */
const MASS = /^(police|flooding|debris|ice|water|smoke|fog|construction|roadwork)/i;

/** The incident's own words: without a leading road name ("Westheimer Rd - Crash", the demo's default) and, for a
 * report, without "reported" ("Crash reported"). */
function what(h: Hazard): string {
  let t = h.title.trim();
  if (h.road) t = t.replace(new RegExp(`^${escapeRe(h.road)}\\s*[-–—:]\\s*`, "i"), "");
  if (h.kind === "report") t = t.replace(/\s+reported$/i, "");
  return t || h.title;
}

/** A hazard as the banner shows it (its distance goes next to it): "Crash on Westheimer Rd", "Drivers report: police
 * on Westheimer Rd". */
export function hazardLabel(h: Hazard): string {
  if (h.kind === "train") {
    if (h.cleared) return `Train cleared on ${h.road}`;
    return h.blocked ? `Train blocking ${h.road}` : `Rail crossing on ${h.road}: trains often block it now`;
  }
  const title = what(h);
  const on = h.road && !title.toLowerCase().includes(h.road.toLowerCase()) ? ` on ${h.road}` : "";
  const prefix = h.kind === "report" ? (h.demo ? "Demo report: " : "Drivers report: ") : "";
  return `${prefix}${prefix ? lower(title) : title}${on}`;
}

/** Where a hazard is: a crossing (or a short road) "in half a mile"; an incident on a long road, whose spot on it we
 * don't know, by the stretch it can be in. `d`: meters to where it starts, `left`: to where it ends. */
function where(d: number, left: number): string {
  if (d > SPOT_M && left - d < SPAN_M) return `in ${spokenDistance(d)}`;
  if (d <= SPOT_M) return left < SPAN_M ? "just ahead" : `in the next ${spokenDistance(left)}`;
  return `somewhere from ${spokenDistance(d)} to ${spokenDistance(left)} ahead`;
}
/** Nearer than this, it's where you are */
const SPOT_M = 60;
/** A road shorter than this is said as one spot */
const SPAN_M = 800;

/** The heads-up for one hazard `d` meters ahead (`left`: to its end; the same for a crossing). */
export function hazardText(h: Hazard, d: number, left = d): string {
  const at = where(d, Math.max(d, left));
  const title = what(h);
  const on = h.road && !title.toLowerCase().includes(h.road.toLowerCase()) ? ` on ${h.road}` : "";
  // Reports don't know how many lanes (they say 1); a title that talks about lanes already said it
  const lanes = h.kind !== "report" && h.lanesBlocked > 0 && !/lane/i.test(title) ? ` ${h.lanesBlocked} lane${h.lanesBlocked > 1 ? "s" : ""} blocked.` : "";
  switch (h.kind) {
    case "train": {
      if (h.cleared) return `The train at the crossing${on} has cleared.`;
      if (h.blocked) {
        const m = h.clearsInMin ? Math.max(1, Math.round(h.clearsInMin)) : 0;
        return `A train is blocking the crossing${on}, ${at}.${m ? ` It should clear in about ${m === 1 ? "a minute" : `${m} minutes`}.` : ""}`;
      }
      return `Rail crossing${on} ${at}. Trains often block it around now.`;
    }
    case "closure":
      return `Road closure${on}, ${at}.`;
    case "report": {
      if (h.demo) return `Demo report: ${lower(title)}${on}, ${at}.`;
      const a = MASS.test(title) ? "" : /^[aeiou]/i.test(title) ? "an " : "a ";
      return `Drivers report ${a}${lower(title)}${on}, ${at}.`;
    }
    default:
      return `Heads up: ${lower(title)}${on}, ${at}.${lanes}`;
  }
}

/** Heads-ups due now: each hazard once, about a minute ahead (at least half a mile), or right away for one on the
 * road you're already on. Keys don't depend on the course, so a re-plan doesn't repeat them. */
export function hazardCalls(list: Hazard[], along: number, speedMps: number | null | undefined, said: ReadonlySet<string>): Say[] {
  const v = Math.max(speedMps && Number.isFinite(speedMps) ? speedMps : DEFAULT_SPEED, 8);
  const lead = clamp(v * 60, 800, 2400);
  const out: Say[] = [];
  for (const h of list) {
    const d = h.along - along;
    const left = (h.until ?? h.along) - along;
    if (left < 0 || d > lead) continue;
    const key = `hazard:${h.key}`;
    if (said.has(key)) continue;
    // "Cleared" only follows a "blocking" heads-up that was said
    if (h.cleared && !said.has(`hazard:${h.key.replace(/:cleared$/, ":blocked")}`)) continue;
    out.push({ key, text: hazardText(h, Math.max(0, d), left), group: key });
  }
  return out;
}

/** The first hazard ahead within `within` meters (for the banner): distance 0 when you're on its road already. */
export function nextHazard(list: Hazard[], along: number, within = 3200): { hazard: Hazard; distance: number } | null {
  for (const h of list) {
    if (h.cleared) continue;
    const d = h.along - along;
    if ((h.until ?? h.along) - along >= 0 && d <= within) return { hazard: h, distance: Math.max(0, d) };
  }
  return null;
}

// ---- reading it aloud -----------------------------------------------------------------------------

const SPOKEN_WORDS: Record<string, string> = {
  Fwy: "Freeway",
  Expy: "Expressway",
  Pkwy: "Parkway",
  Hwy: "Highway",
  Blvd: "Boulevard",
  Rd: "Road",
  Ave: "Avenue",
  Ln: "Lane",
  Ct: "Court",
  Cir: "Circle",
  Pl: "Place",
  Tpke: "Turnpike",
  Frwy: "Freeway",
};
const COMPASS: Record<string, string> = { N: "North", S: "South", E: "East", W: "West" };

/**
 * Instruction text as it should be read aloud: the screen's short road words in full ("Southwest Fwy" -> "Southwest
 * Freeway"), "St" and "Dr" after a name ("Main St" -> "Main Street", not "Saint"), route numbers ("I-69" -> "I 69",
 * "US-59" -> "U.S. 59"), "a/b" as "a or b" for route numbers and "a, b" for places, and "N Main St" -> "North Main
 * Street".
 */
export function forSpeech(text: string): string {
  let t = text;
  // Directions before a name ("N Main St"), before "U.S." makes an "S." of its own
  t = t.replace(/(^|[\s(])([NSEW]) (?=[A-Z][a-z])/g, (_, pre: string, c: string) => `${pre}${COMPASS[c]} `);
  // Route numbers: "I-69/US-59" -> "I 69 or U.S. 59"
  t = t.replace(/\bUS-(\d+)/g, "U.S. $1").replace(/\b(I|TX|SH|FM|BW|SL|CR)-(\d+[A-Z]?)\b/g, "$1 $2");
  t = t.replace(/(\d[A-Z]?)\s*\/\s*(?=(I|U\.S\.|TX|SH|FM|BW|SL|CR) \d)/g, "$1 or ");
  // Whatever else is joined by a slash: places ("Galleria / Uptown" is read "Galleria, Uptown")
  t = t.replace(/\s*\/\s*/g, ", ");
  // Short road words at the end of a name
  t = t.replace(/\b(Fwy|Frwy|Expy|Pkwy|Hwy|Blvd|Rd|Ave|Ln|Ct|Cir|Pl|Tpke)\b/g, (w: string) => SPOKEN_WORDS[w] ?? w);
  // "St" / "Dr" after a name, not before one ("St Joseph Pkwy" is Saint Joseph)
  t = t.replace(/\b([A-Za-z0-9]\w*) (St|Dr)\b(?! [A-Z][a-z])/g, (_, w: string, k: string) => `${w} ${k === "St" ? "Street" : "Drive"}`);
  return t.replace(/\s{2,}/g, " ");
}
