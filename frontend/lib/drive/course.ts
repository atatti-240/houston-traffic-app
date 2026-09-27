/**
 * A route laid out for driving: its line with every turn, road segment, train crossing and incident placed
 * "meters along" it, and a time profile for the arrival time. `locate` turns a GPS fix into progress: how far along,
 * how far off the line, the next turn and the distance to it, what's left.
 * No framework imports (unit-tested with `node --test`).
 */

import type { Incident, LatLngTuple, Route, RouteCrossing, RouteStep } from "../types";
import { distanceM, measure, pointAt, project, type Line, type Pt } from "./geo.ts";

/** Within this of a turn's spot (or past it) the turn is done: the next one is up. */
export const PASSED_M = 8;
/** This close to the end (and on the line) you've arrived. */
export const ARRIVE_M = 35;
/** Road features farther than this from the line aren't on it. */
const ON_LINE_M = 150;
/** A segment's shape this close to the line runs along it */
const ON_SEGMENT_M = 60;
const DENSIFY_M = 100;
/** ... along at least this share of it */
const FOLLOWED = 0.5;
/** Nearer than this to the line you're on it (for its road segment and arriving) */
const LOCAL_OK_M = 60;

export interface CourseStep {
  step: RouteStep;
  /** Meters along the line where its maneuver happens */
  along: number;
}

export interface CourseSegment {
  id: string;
  name: string;
  roadClass: string;
  /** Where it starts and ends along the line */
  from: number;
  to: number;
  /** False when the line doesn't follow this road (the directions took another way): it then only marks where it
   * would be (between its neighbours) */
  onLine: boolean;
  /** Posted limit when the data has one (another branch adds it to route segments); null when unknown */
  speedLimitMph: number | null;
  incident: Incident | null;
  closure: Incident | null;
}

export interface CourseCrossing {
  crossing: RouteCrossing;
  along: number;
}

export interface Course {
  /** The route's id plus where its line starts: a new plan from where you are is a new course */
  key: string;
  line: Line;
  /** Turn-by-turn, in order (empty when the route has no directions) */
  steps: CourseStep[];
  segments: CourseSegment[];
  crossings: CourseCrossing[];
  /** The trip's traffic-aware time, seconds */
  totalS: number;
  /** Seconds from the start at points along the line: [meters along, seconds] (increasing) */
  timeline: [number, number][];
}

/** A segment's posted limit, read as optional: missing, null or nonsense is "unknown". */
function speedLimit(seg: object): number | null {
  const v = (seg as { speed_limit_mph?: unknown }).speed_limit_mph;
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v < 100 ? Math.round(v) : null;
}

/** Points at most `every` meters apart along a polyline. */
function densify(points: LatLngTuple[], every: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    out.push([a[0], a[1]]);
    const b = points[i + 1];
    if (!b) break;
    const n = Math.floor(distanceM(a, b) / every);
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / (n + 1), a[1] + ((b[1] - a[1]) * k) / (n + 1)]);
  }
  return out;
}

export function buildCourse(route: Route): Course {
  const line = measure(route.geometry.map(([a, b]) => [a, b] as Pt));
  const raw = route.directions?.steps ?? [];

  // Each maneuver, placed at or after the one before it (the line may pass near a later turn's spot early on)
  const steps: CourseStep[] = [];
  let last = 0;
  raw.forEach((step, i) => {
    let along: number;
    if (i === 0) along = 0;
    else if (i === raw.length - 1 && step.maneuver.type === "arrive") along = line.length;
    else {
      const loc = step.maneuver.location;
      const near = project(line, loc, last, last + (raw[i - 1]?.distance_m ?? 0) * 1.5 + 300);
      const any = near && near.off <= ON_LINE_M ? near : project(line, loc, last);
      along = any ? any.along : last;
    }
    last = Math.max(last, along);
    steps.push({ step, along: last });
  });

  // Our road segments along the line. The line takes the real ramps, so a segment's ends (the middle of an
  // interchange) can be a few hundred meters off it: a segment covers the stretch where its own shape runs along the
  // line. One the line mostly doesn't follow (the directions took a parallel road) sits in the gap where it would be,
  // so a slowdown on it still counts as ahead or behind.
  const segments: CourseSegment[] = [];
  let cursor = 0;
  for (const s of route.segments) {
    let from = Infinity;
    let to = -Infinity;
    const pts = densify(s.geometry, DENSIFY_M);
    let near = 0;
    for (const pt of pts) {
      const q = project(line, pt, cursor - 200, Infinity, cursor);
      if (!q || q.off > ON_SEGMENT_M) continue;
      near++;
      from = Math.min(from, q.along);
      to = Math.max(to, q.along);
    }
    const onLine = to > from && near >= pts.length * FOLLOWED;
    if (onLine) cursor = to;
    segments.push({
      id: s.id,
      name: s.name,
      roadClass: s.road_class,
      from: onLine ? from : cursor,
      to: onLine ? to : cursor,
      onLine,
      speedLimitMph: speedLimit(s),
      incident: s.incident,
      closure: s.closure,
    });
  }
  // Segments off the line reach to the next one that's on it
  for (let i = segments.length - 1; i >= 0; i--) {
    if (!segments[i].onLine) segments[i].to = segments[i + 1]?.from ?? line.length;
  }

  const crossings: CourseCrossing[] = [];
  for (const c of route.crossings) {
    const q = project(line, [c.lat, c.lng]);
    if (q && q.off <= ON_LINE_M) crossings.push({ crossing: c, along: q.along });
  }

  // Time: OSRM's per-step times give the shape (fast on freeways, slow in town), scaled so they add up to our
  // traffic-aware total. Without steps, time goes with distance.
  const totalS = Math.max(0, route.total_min * 60);
  const timeline: [number, number][] = [[0, 0]];
  const stepS = steps.reduce((a, s) => a + Math.max(0, s.step.duration_s), 0);
  if (steps.length > 1 && stepS > 0) {
    let t = 0;
    for (let i = 0; i < steps.length - 1; i++) {
      t += (Math.max(0, steps[i].step.duration_s) / stepS) * totalS;
      const at = steps[i + 1].along;
      if (at > timeline[timeline.length - 1][0]) timeline.push([at, t]);
    }
  }
  if (timeline[timeline.length - 1][0] < line.length) timeline.push([line.length, totalS]);
  else timeline[timeline.length - 1][1] = totalS;

  const start = line.points[0];
  return {
    key: `${route.id ?? route.summary}@${start ? `${start[0].toFixed(5)},${start[1].toFixed(5)}` : ""}`,
    line,
    steps,
    segments,
    crossings,
    totalS,
    timeline,
  };
}

/** Seconds from the start to `along`, from the time profile. */
export function timeAt(course: Course, along: number): number {
  const tl = course.timeline;
  if (along <= tl[0][0]) return tl[0][1];
  for (let i = 1; i < tl.length; i++) {
    const [a1, t1] = tl[i];
    if (along <= a1) {
      const [a0, t0] = tl[i - 1];
      return a1 > a0 ? t0 + ((along - a0) / (a1 - a0)) * (t1 - t0) : t1;
    }
  }
  return tl[tl.length - 1][1];
}

export interface Progress {
  along: number;
  /** Meters from the line */
  off: number;
  /** The closest point on the line */
  at: Pt;
  /** The road's heading there */
  heading: number;
  /** Index in course.steps of the next maneuver (null: none left, or no steps) */
  next: number | null;
  toNext: number;
  remainingM: number;
  remainingS: number;
  /** The road segment you're on (ours, with its limit and incidents), null on the way to or from our roads */
  segment: CourseSegment | null;
  arrived: boolean;
}

/** Where `p` is on the course. `hint`: the last `along`, so a line passing near itself doesn't make you jump. */
export function locate(course: Course, p: Pt, hint: number | null = null): Progress {
  const { line } = course;
  const q = project(line, p, -Infinity, Infinity, hint);
  const along = q?.along ?? 0;
  const off = q?.off ?? Infinity;
  let next: number | null = null;
  for (let i = 1; i < course.steps.length; i++) {
    if (course.steps[i].along > along + PASSED_M) {
      next = i;
      break;
    }
  }
  const remainingM = Math.max(0, line.length - along);
  const segment = off <= LOCAL_OK_M ? (course.segments.find((s) => s.onLine && along >= s.from && along < s.to) ?? null) : null;
  return {
    along,
    off,
    at: q?.at ?? p,
    heading: pointAt(line, along).heading,
    next,
    toNext: next === null ? remainingM : course.steps[next].along - along,
    remainingM,
    remainingS: Math.max(0, course.totalS - timeAt(course, along)),
    segment,
    arrived: remainingM <= ARRIVE_M && off <= LOCAL_OK_M,
  };
}

// ---- what's ahead -----------------------------------------------------------------------------------

/** Live data the course is checked against (a subset of GET /live). */
export interface LiveInput {
  incidents?: { id: string; segment_id: string | null; kind: string; title: string; lanes_blocked: number; source: string }[];
  crossings?: { id: string; status: "blocked" | "clear" | "unknown"; time_to_clear_min: number | null }[];
}

export interface Hazard {
  /** Stable across re-plans, so it's announced once */
  key: string;
  kind: "train" | "closure" | "incident" | "report";
  along: number;
  /** The road it's on */
  road: string;
  /** "Multi-vehicle crash", "Train crossing" */
  title: string;
  lanesBlocked: number;
  /** A train blocking the crossing right now */
  blocked: boolean;
  /** Minutes until a blocking train clears, when known */
  clearsInMin: number | null;
  /** Chance of a train there around now, 0-1 */
  chance: number;
}

/** Crossings with at least this chance of a train are worth a heads-up. */
export const TRAIN_CHANCE = 0.25;

const isReport = (source: string) => /driver/i.test(source);

/** Trains, closures, incidents and driver reports on the course, nearest first (including ones already passed). */
export function hazards(course: Course, live: LiveInput | null = null): Hazard[] {
  const out: Hazard[] = [];
  const liveCrossing = new Map((live?.crossings ?? []).map((c) => [c.id, c]));
  for (const { crossing: c, along } of course.crossings) {
    const lc = liveCrossing.get(c.id);
    // Live status wins; without it, a route planned while a train was there says so (a certain block)
    const blocked = lc ? lc.status === "blocked" : c.live && c.block_probability >= 0.99;
    if (!blocked && c.block_probability < TRAIN_CHANCE) continue;
    out.push({
      key: `x:${c.id}${blocked ? ":blocked" : ""}`,
      kind: "train",
      along,
      road: c.name.split(" @ ")[0],
      title: "Train crossing",
      lanesBlocked: 0,
      blocked,
      clearsInMin: blocked ? (lc?.time_to_clear_min ?? null) : null,
      chance: blocked ? 1 : c.block_probability,
    });
  }
  const seen = new Set<string>();
  const add = (seg: CourseSegment, inc: { id: string; kind: string; title: string; lanes_blocked: number; source: string }, closed: boolean) => {
    if (seen.has(inc.id)) return;
    seen.add(inc.id);
    out.push({
      key: `i:${inc.id}`,
      kind: closed ? "closure" : isReport(inc.source) ? "report" : "incident",
      along: seg.from,
      road: seg.name,
      title: inc.title,
      lanesBlocked: inc.lanes_blocked,
      blocked: false,
      clearsInMin: null,
      chance: 1,
    });
  };
  // Only on roads the line really takes (you'd pass it)
  const followed = course.segments.filter((s) => s.onLine);
  for (const seg of followed) {
    if (seg.closure) add(seg, seg.closure, true);
    if (seg.incident) add(seg, seg.incident, seg.incident.kind === "closure");
  }
  // Incidents that showed up after the route was planned
  const bySeg = new Map(followed.map((s) => [s.id, s]));
  for (const inc of live?.incidents ?? []) {
    const seg = inc.segment_id ? bySeg.get(inc.segment_id) : undefined;
    if (seg) add(seg, inc, inc.kind === "closure");
  }
  return out.sort((a, b) => a.along - b.along);
}
