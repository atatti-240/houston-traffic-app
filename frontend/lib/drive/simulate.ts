/**
 * The demo's simulated drive: a spot moving along the course at the roads' usual speeds (from the turn-by-turn
 * times, or city speed without them), sped up by `factor`. Its fixes go through the same code as real GPS.
 * No framework imports (unit-tested with `node --test`).
 */

import type { Course } from "./course.ts";
import { pointAt, type Pt } from "./geo.ts";

const CITY = 13.4; // m/s, about 30 mph
const MIN = 5;
const MAX = 33; // about 75 mph

/** The usual speed at `along`, m/s: the step's own distance over its time. */
export function speedAt(course: Course, along: number): number {
  const { steps } = course;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].along <= along) {
      const s = steps[i].step;
      if (s.duration_s > 0 && s.distance_m > 0) return Math.max(MIN, Math.min(MAX, s.distance_m / s.duration_s));
      break;
    }
  }
  return CITY;
}

export interface SimFix {
  along: number;
  at: Pt;
  heading: number;
  /** m/s, as the car would go (times `factor`) */
  speed: number;
  done: boolean;
}

/** Move `dtS` seconds on from `along`, `factor` times faster than real life. */
export function simStep(course: Course, along: number, dtS: number, factor: number): SimFix {
  const v = speedAt(course, along) * factor;
  const next = Math.min(course.line.length, along + v * dtS);
  const { at, heading } = pointAt(course.line, next);
  return { along: next, at, heading, speed: v, done: next >= course.line.length };
}
