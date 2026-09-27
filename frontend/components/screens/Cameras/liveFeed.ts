"use client";

/**
 * A camera's live AI feed: polls GET /cv/cameras/{id} (which also tells the backend someone is
 * watching, so the camera AI switches to this camera) and keeps the recent vehicle boxes.
 *
 * The video plays `video_delay_ms` behind real time, and every box set carries the time of its
 * frame on the server's clock. BoxTrack gives the boxes for any moment of the video: between two
 * box sets it moves each vehicle's box from one to the next (matched by position and size), so
 * the boxes follow the cars at the video's frame rate even though the detector runs about once a
 * second; boxes without a match fade out or in.
 */

import { useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import type { LiveFeedDetail, VehicleBox } from "@/lib/types";

/** The frame is 16:9: distances in x count 16/9 times more than the same fraction in y. */
const ASPECT = 16 / 9;
/** Show the last boxes this long past their frame when no newer ones have come in yet. */
const HOLD_MS = 700;
/** Box sets further apart than this aren't blended (the detector stalled). */
const MAX_GAP_MS = 2600;
const KEEP_MS = 15000;

export interface Snapshot {
  t: number;
  boxes: VehicleBox[];
}

export interface DrawnBox {
  x: number;
  y: number;
  w: number;
  h: number;
  cls: string;
  opacity: number;
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;

function toDrawn(b: VehicleBox, opacity = 1): DrawnBox {
  return { x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1], cls: b[4], opacity };
}

/** Pairs [i, j] of boxes that are the same vehicle in two box sets: closest first, relative to the
 * vehicle's size, same class preferred. */
export function matchBoxes(a: VehicleBox[], b: VehicleBox[]): [number, number][] {
  const cand: [number, number, number][] = [];
  for (let i = 0; i < a.length; i++) {
    const [ax1, ay1, ax2, ay2] = a[i];
    const aw = (ax2 - ax1) * ASPECT;
    const ah = ay2 - ay1;
    for (let j = 0; j < b.length; j++) {
      const [bx1, by1, bx2, by2] = b[j];
      const bw = (bx2 - bx1) * ASPECT;
      const bh = by2 - by1;
      const size = Math.max(Math.hypot(aw, ah), Math.hypot(bw, bh));
      const d = Math.hypot(((ax1 + ax2 - bx1 - bx2) / 2) * ASPECT, (ay1 + ay2 - by1 - by2) / 2) / size;
      const area = (aw * ah) / (bw * bh || 1e-9);
      if (d > 1.3 || area > 3 || area < 1 / 3) continue;
      cand.push([d + (a[i][4] === b[j][4] ? 0 : 0.4), i, j]);
    }
  }
  cand.sort((p, q) => p[0] - q[0]);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const out: [number, number][] = [];
  for (const [, i, j] of cand) {
    if (usedA.has(i) || usedB.has(j)) continue;
    usedA.add(i);
    usedB.add(j);
    out.push([i, j]);
  }
  return out;
}

export class BoxTrack {
  snaps: Snapshot[] = [];
  private pairs = new Map<string, [number, number][]>();

  add(list: Snapshot[]) {
    const byT = new Map(this.snaps.map((s) => [s.t, s]));
    for (const s of list) byT.set(s.t, s);
    const latest = Math.max(0, ...byT.keys());
    this.snaps = [...byT.values()].filter((s) => s.t >= latest - KEEP_MS).sort((p, q) => p.t - q.t);
    const keep = new Set(this.snaps.map((s) => s.t));
    for (const k of this.pairs.keys()) if (!keep.has(Number(k.split(":")[0]))) this.pairs.delete(k);
  }

  clear() {
    this.snaps = [];
    this.pairs.clear();
  }

  /** The newest box set's time, to ask only for newer ones. */
  latest(): number | undefined {
    return this.snaps.length ? this.snaps[this.snaps.length - 1].t : undefined;
  }

  /** The boxes to draw on the video frame taken at `t` (server clock, ms). */
  at(t: number): DrawnBox[] {
    const s = this.snaps;
    let i = -1;
    for (let k = s.length - 1; k >= 0; k--)
      if (s[k].t <= t) {
        i = k;
        break;
      }
    if (i < 0) return [];
    const a = s[i];
    const b = s[i + 1];
    if (!b || b.t - a.t > MAX_GAP_MS) {
      const age = t - a.t;
      return age <= HOLD_MS ? a.boxes.map((x) => toDrawn(x, 1 - Math.max(0, age - HOLD_MS / 2) / (HOLD_MS / 2))) : [];
    }
    const key = `${a.t}:${b.t}`;
    let pairs = this.pairs.get(key);
    if (!pairs) {
      pairs = matchBoxes(a.boxes, b.boxes);
      this.pairs.set(key, pairs);
    }
    const f = (t - a.t) / (b.t - a.t);
    const out: DrawnBox[] = [];
    const seenA = new Set<number>();
    const seenB = new Set<number>();
    for (const [ia, ib] of pairs) {
      const p = a.boxes[ia];
      const q = b.boxes[ib];
      seenA.add(ia);
      seenB.add(ib);
      const box: VehicleBox = [lerp(p[0], q[0], f), lerp(p[1], q[1], f), lerp(p[2], q[2], f), lerp(p[3], q[3], f), f < 0.5 ? p[4] : q[4], q[5], q[6]];
      out.push(toDrawn(box));
    }
    // Vehicles only one of the two sets found: fade out after the first, fade in toward the second.
    a.boxes.forEach((x, k) => !seenA.has(k) && f < 0.5 && out.push(toDrawn(x, 1 - f * 2)));
    b.boxes.forEach((x, k) => !seenB.has(k) && f > 0.5 && out.push(toDrawn(x, (f - 0.5) * 2)));
    return out;
  }
}

export interface LiveFeedState {
  detail: LiveFeedDetail | null;
  track: BoxTrack;
  /** Server clock minus this browser's clock (ms), once known */
  offset: { current: number | null };
}

/** Poll a camera's live AI feed while it's on screen (null camera: off). Not while the tab is hidden:
 * asking counts as watching, and a forgotten tab would keep the camera AI on this camera. */
export function useLiveFeed(cameraId: string | null): LiveFeedState {
  const [detail, setDetail] = useState<LiveFeedDetail | null>(null);
  const track = useRef(new BoxTrack());
  const offset = useRef<number | null>(null);
  const bestRtt = useRef(Infinity);

  useEffect(() => {
    setDetail(null);
    track.current.clear();
    offset.current = null;
    bestRtt.current = Infinity;
    if (!cameraId) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (document.hidden) {
        timer = setTimeout(poll, 1000);
        return;
      }
      const t0 = Date.now();
      let live = false;
      try {
        const d = await api.cvCamera(cameraId, track.current.latest());
        const t1 = Date.now();
        if (stop) return;
        // The server's clock vs ours, from the answers with the least network delay.
        const rtt = t1 - t0;
        const est = d.server_time - (t0 + t1) / 2;
        if (offset.current === null || rtt <= bestRtt.current * 2 + 20) {
          offset.current = offset.current === null ? est : offset.current * 0.7 + est * 0.3;
          bestRtt.current = Math.min(bestRtt.current, rtt);
        }
        track.current.add(d.detections);
        setDetail(d);
        live = d.status === "live";
      } catch {
        // keep the last answer; the card shows it as it was
      }
      if (!stop) timer = setTimeout(poll, live ? 500 : 2000);
    };
    poll();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [cameraId]);

  return { detail, track: track.current, offset };
}
