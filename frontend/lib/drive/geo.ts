/**
 * Small geometry for driving mode: distances, bearings and where a point falls along a polyline.
 * City-sized distances, so a flat (equirectangular) projection around each point is plenty.
 * No framework imports: unit-tested with `node --test` (lib/drive/*.test.ts).
 */

export type Pt = [number, number]; // [lat, lng]

const R = 6_371_000; // earth radius, m
const RAD = Math.PI / 180;

/** Meters between two points (haversine). */
export function distanceM(a: Pt, b: Pt): number {
  const dLat = (b[0] - a[0]) * RAD;
  const dLng = (b[1] - a[1]) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Compass bearing from a to b, 0-359 (0 = north, 90 = east). */
export function bearing(a: Pt, b: Pt): number {
  const y = Math.sin((b[1] - a[1]) * RAD) * Math.cos(b[0] * RAD);
  const x = Math.cos(a[0] * RAD) * Math.sin(b[0] * RAD) - Math.sin(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.cos((b[1] - a[1]) * RAD);
  return ((Math.atan2(y, x) / RAD) % 360 + 360) % 360;
}

/** Smallest angle between two bearings, 0-180. */
export function angleDiff(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

/** A polyline with its running length: cum[i] = meters from the start to points[i]. */
export interface Line {
  points: Pt[];
  cum: number[];
  length: number;
}

export function measure(points: Pt[]): Line {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + distanceM(points[i - 1], points[i]));
  return { points, cum, length: cum[cum.length - 1] ?? 0 };
}

/** Where a point falls on a polyline: `along` meters from its start, `off` meters away from it. */
export interface Projection {
  along: number;
  off: number;
  /** The closest point on the line */
  at: Pt;
  /** Index of the line's piece it fell on (points[i] -> points[i + 1]) */
  index: number;
}

/** The point on piece i closest to p, in meters on a local flat projection. */
function projectPiece(line: Line, i: number, p: Pt): Projection {
  const a = line.points[i];
  const b = line.points[i + 1] ?? a;
  const k = Math.cos(p[0] * RAD) * RAD * R; // meters per degree of longitude here
  const m = RAD * R; // meters per degree of latitude
  const ax = (a[1] - p[1]) * k;
  const ay = (a[0] - p[0]) * m;
  const bx = (b[1] - p[1]) * k;
  const by = (b[0] - p[0]) * m;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  const x = ax + t * dx;
  const y = ay + t * dy;
  const pieceLen = line.cum[i + 1] !== undefined ? line.cum[i + 1] - line.cum[i] : 0;
  return {
    along: line.cum[i] + t * pieceLen,
    off: Math.hypot(x, y),
    at: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])],
    index: i,
  };
}

/** With a preferred `along`, a point this much farther along (or back) costs 1 m more off the line. */
const PREFER_SLACK_M = 200;
const PREFER_WEIGHT = 0.05;

/**
 * Project p onto the line. With `from` / `to` (meters along), only that stretch is searched (it still returns the
 * closest point there, however far). With `prefer` (meters along), a spot near it wins over a slightly closer one far
 * from it (a line passing near itself). An empty line gives null.
 */
export function project(line: Line, p: Pt, from = -Infinity, to = Infinity, prefer: number | null = null): Projection | null {
  const n = line.points.length;
  if (!n) return null;
  if (n === 1) return { along: 0, off: distanceM(line.points[0], p), at: line.points[0], index: 0 };
  const cost = (q: Projection) => q.off + (prefer === null ? 0 : Math.max(0, Math.abs(q.along - prefer) - PREFER_SLACK_M) * PREFER_WEIGHT);
  let best: Projection | null = null;
  let bestCost = Infinity;
  for (let i = 0; i < n - 1; i++) {
    if (line.cum[i + 1] < from || line.cum[i] > to) continue;
    const q = projectPiece(line, i, p);
    const c = cost(q);
    if (c < bestCost) {
      best = q;
      bestCost = c;
    }
  }
  return best;
}

/** The point `along` meters from the line's start (clamped to its ends), and the heading there. */
export function pointAt(line: Line, along: number): { at: Pt; heading: number } {
  const { points, cum } = line;
  if (points.length < 2) return { at: points[0] ?? [0, 0], heading: 0 };
  const d = Math.max(0, Math.min(line.length, along));
  // Binary search for the piece holding d
  let lo = 0;
  let hi = points.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid - 1;
  }
  // Skip zero-length pieces so the heading means something
  let i = lo;
  while (i < points.length - 2 && cum[i + 1] - cum[i] < 0.01) i++;
  const a = points[i];
  const b = points[i + 1];
  const len = cum[i + 1] - cum[i];
  const t = len > 0 ? Math.max(0, Math.min(1, (d - cum[i]) / len)) : 0;
  return { at: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], heading: bearing(a, b) };
}

/** A point `meters` away from p toward `heading` (for tests and the demo's wrong turn). */
export function offset(p: Pt, heading: number, meters: number): Pt {
  const dLat = (meters * Math.cos(heading * RAD)) / (RAD * R);
  const dLng = (meters * Math.sin(heading * RAD)) / (RAD * R * Math.cos(p[0] * RAD));
  return [p[0] + dLat, p[1] + dLng];
}
