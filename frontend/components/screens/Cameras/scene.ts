/**
 * Procedural "live video" for a traffic camera, drawn in the design's style (Live cameras):
 * dark sky and buildings, a perspective highway with 6 lanes, cars as small rectangles with
 * head/tail lights, rain streaks, and for rail-crossing cameras the tracks, gates and a freight
 * train. Everything is seeded by the camera id so each camera looks different.
 *
 * A car's depth `t` runs from the vanishing point (0) to the bottom edge (1). Lanes on the left
 * come toward the camera (headlights), lanes on the right drive away (tail lights).
 */

import type { Level } from "@/lib/theme";

export const VIEW_W = 350;
export const VIEW_H = 220;
export const HORIZON = 72;
const VX = 175;

/** Cars loop over depth [T0, T0 + LOOP): past the bottom edge they re-enter at the horizon. */
const T0 = 0.02;
const LOOP = 1.18;
const DENSITY: Record<Level, number> = { heavy: 8, moderate: 4, light: 2 };
/** Depth units per second (heavy creeps in stop-and-go waves) */
const SPEED: Record<Level, number> = { heavy: 0.02, moderate: 0.05, light: 0.11 };
const LANES = [
  { b: -10, toward: true },
  { b: 50, toward: true },
  { b: 110, toward: true },
  { b: 240, toward: false },
  { b: 300, toward: false },
  { b: 360, toward: false },
];

/** While a train blocks the crossing, no car sits on or right next to the tracks. */
const CLEAR_FROM = 0.19;
const CLEAR_TO = 0.4;
const TRAIN_SPEED = 16; // px / s

export interface FeedInput {
  id: string;
  kind: string;
  level: Level;
  weather: boolean;
  /** A train is blocking the crossing right now */
  blocked: boolean;
}

interface Lane {
  b: number;
  toward: boolean;
  cars: number[];
  v: number;
  wave: number;
  offset: number;
}

export interface RailCar {
  x: number;
  w: number;
  type: "box" | "tank" | "hopper";
  color: string;
}

export interface Scene {
  level: Level;
  lanes: Lane[];
  rain: { x: number; y: number }[];
  /** A rail-crossing camera */
  crossing: boolean;
  /** A freight train across the road (gates down) */
  train: { cars: RailCar[]; length: number } | null;
  skyline: string;
  windows: string;
  time: number;
  trainX: number;
}

export interface Frame {
  bodies: string;
  heads: string;
  tails: string;
  rain: string;
  /** translate-x of the train group */
  trainX: number;
  /** crossing lights: which of the pair is lit */
  blink: boolean;
}

export function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 997) + 1;
}

/** The design's little LCG. */
function rng(seed: number) {
  let s = (seed * 97 + 13) % 233280;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const rect = (x: number, y: number, w: number, h: number) => `M${r1(x)} ${r1(y)}h${r1(w)}v${r1(h)}h${r1(-w)}Z`;
const mod = (a: number, n: number) => ((a % n) + n) % n;

function skyline(rnd: () => number): { path: string; windows: string } {
  let windows = "";
  const cluster = (x0: number, x1: number) => {
    let d = `M${x0} ${HORIZON}`;
    let x = x0;
    while (x < x1) {
      const w = Math.min(x1 - x, 14 + Math.round(rnd() * 12));
      const top = 12 + Math.round(rnd() * 40);
      d += ` V${top} H${x + w}`;
      if (w >= 10 && rnd() < 0.6) {
        const wx = x + 3 + Math.round(rnd() * (w - 9));
        const wy = top + 5 + Math.round(rnd() * Math.max(0, HORIZON - top - 16));
        windows += `M${wx} ${wy}h3v3h-3z`;
      }
      x += w;
    }
    return `${d} V${HORIZON} Z`;
  };
  return { path: `${cluster(0, 118)} ${cluster(228, VIEW_W)}`, windows };
}

function consist(rnd: () => number): { cars: RailCar[]; length: number } {
  const colors = ["#5A3328", "#6B4A2E", "#3E4A52", "#4B4F57", "#2F3F3A", "#5C5448", "#4A2F2A"];
  const cars: RailCar[] = [];
  let x = 0;
  const n = 8 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const r = rnd();
    const type: RailCar["type"] = r < 0.55 ? "box" : r < 0.8 ? "tank" : "hopper";
    const w = type === "box" ? 112 + Math.round(rnd() * 14) : type === "tank" ? 96 + Math.round(rnd() * 12) : 100 + Math.round(rnd() * 12);
    cars.push({ x, w, type, color: colors[Math.floor(rnd() * colors.length)] });
    x += w + 6;
  }
  return { cars, length: x };
}

/** Does this camera show a train at the crossing right now? Only when the crossing is blocked live
 * (never from the note's text or a "Train likely" prediction; a missing flag means no train). */
export function showsTrain(cam: { kind: string; crossing_blocked?: boolean | null }): boolean {
  return cam.kind === "train" && cam.crossing_blocked === true;
}

export function createScene(cam: FeedInput): Scene {
  const rnd = rng(seedOf(cam.id));
  const heavy = cam.level === "heavy";
  const crossing = cam.kind === "train";
  const blocked = crossing && cam.blocked;

  const lanes: Lane[] = LANES.map((ln) => {
    const n = Math.max(1, Math.round(DENSITY[cam.level] * (0.7 + rnd() * 0.6)));
    let cars: number[];
    if (heavy) {
      // bumper to bumper: evenly spaced (as in the design), continued around the loop
      const count = Math.max(n + 1, Math.round((n * LOOP) / 0.88));
      const gap = LOOP / count;
      cars = Array.from({ length: count }, (_, k) => T0 + mod(0.1 + k * gap + rnd() * 0.04 - T0, LOOP));
    } else {
      const count = Math.max(1, Math.round((n * LOOP) / 0.85));
      cars = Array.from({ length: count }, () => T0 + rnd() * LOOP).sort((a, b) => a - b);
      for (let i = 1; i < cars.length; i++) if (cars[i] - cars[i - 1] < 0.08) cars[i] = cars[i - 1] + 0.08;
    }
    return { b: ln.b, toward: ln.toward, cars, v: blocked ? 0 : SPEED[cam.level] * (0.85 + rnd() * 0.3), wave: rnd() * Math.PI * 2, offset: 0 };
  });

  const rain: Scene["rain"] = [];
  if (cam.weather) for (let i = 0; i < 90; i++) rain.push({ x: rnd() * 360, y: rnd() * VIEW_H });

  const sky = skyline(rng(seedOf(cam.id) + 7));
  return {
    level: cam.level,
    lanes,
    rain,
    crossing,
    train: blocked ? consist(rnd) : null,
    skyline: sky.path,
    windows: sky.windows,
    time: 0,
    trainX: 0,
  };
}

/** Advance the scene by dt seconds. */
export function step(sc: Scene, dt: number) {
  sc.time += dt;
  for (const ln of sc.lanes) {
    if (!ln.v) continue;
    const f = sc.level === "heavy" ? (0.5 + 0.5 * Math.sin(sc.time * 0.45 + ln.wave)) ** 2 : 1;
    ln.offset += ln.v * f * dt;
  }
  if (sc.train) sc.trainX = (sc.trainX + TRAIN_SPEED * dt) % sc.train.length;
  for (const r of sc.rain) {
    r.y += 250 * dt;
    r.x -= 83 * dt;
    if (r.y > VIEW_H + 4) r.y -= VIEW_H + 14;
    if (r.x < -4) r.x += 364;
  }
}

/** The scene's current picture as SVG path strings. */
export function frame(sc: Scene): Frame {
  let bodies = "";
  let heads = "";
  let tails = "";
  const blocked = !!sc.train;
  for (const ln of sc.lanes) {
    for (const c of ln.cars) {
      const t = T0 + mod(c - T0 + (ln.toward ? ln.offset : -ln.offset), LOOP);
      if (t < 0.05) continue;
      if (blocked && t > CLEAR_FROM && t < CLEAR_TO) continue;
      const cx = VX + (ln.b - VX) * t;
      const y = HORIZON + 148 * t;
      const w = 4 + 34 * t;
      const h = 3 + 20 * t;
      bodies += rect(cx - w / 2, y - h, w, h);
      const lw = Math.max(1, w * 0.18);
      const lh = Math.max(0.8, h * 0.18);
      const ly = y - h * 0.35;
      const piece = rect(cx - w / 2 + w * 0.08, ly, lw, lh) + rect(cx + w / 2 - w * 0.08 - lw, ly, lw, lh);
      if (ln.toward) heads += piece;
      else tails += piece;
    }
  }
  let rain = "";
  for (const r of sc.rain) rain += `M${r1(r.x)} ${r1(r.y)}l-3 9`;
  const x = sc.train ? r1(mod(sc.trainX, sc.train.length) - sc.train.length) : 0;
  return { bodies, heads, tails, rain, trainX: x, blink: Math.floor(sc.time * 1.6) % 2 === 0 };
}
