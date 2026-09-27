// Driving mode: when to re-plan, and how often.  Run: node --test lib/drive/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCourse } from "./course.ts";
import { testRoute } from "./fixture.ts";
import {
  BACKOFF_MS,
  COOLDOWN_MS,
  OFF_ROUTE_MS,
  canReroute,
  failed,
  isOffRoute,
  newHeavyAhead,
  onRoute,
  openGate,
  started,
  succeeded,
  trackOffRoute,
  type OffRoute,
} from "./reroute.ts";

/** Feed fixes [ms, meters off, accuracy] and say whether it's off route after the last one. */
function feed(fixes: [number, number, number][]): { s: OffRoute; off: boolean } {
  let s = onRoute();
  for (const [at, off, acc] of fixes) s = trackOffRoute(s, off, acc, at);
  const last = fixes[fixes.length - 1][0];
  return { s, off: isOffRoute(s, last) };
}

test("off the route for a few seconds: re-plan", () => {
  assert.equal(feed([[0, 80, 10], [1000, 85, 10], [2000, 90, 10]]).off, false); // not long enough yet
  assert.equal(feed([[0, 80, 10], [2000, 85, 10], [OFF_ROUTE_MS, 90, 10]]).off, true);
});

test("a single stray fix doesn't count", () => {
  assert.equal(feed([[0, 80, 10], [1000, 10, 10], [OFF_ROUTE_MS + 500, 80, 10]]).off, false);
});

test("wobbling around the route doesn't trigger a re-plan", () => {
  const fixes: [number, number, number][] = [];
  for (let t = 0; t <= 30_000; t += 1000) fixes.push([t, t % 2000 ? 60 : 25, 10]);
  let s = onRoute();
  for (const [at, off, acc] of fixes) {
    s = trackOffRoute(s, off, acc, at);
    assert.equal(isOffRoute(s, at), false, `at ${at}`);
  }
});

test("between 35 and 50 m it holds: neither starts nor clears", () => {
  assert.equal(feed([[0, 40, 10], [5000, 45, 10]]).off, false);
  assert.equal(feed([[0, 70, 10], [2000, 45, 10], [OFF_ROUTE_MS, 70, 10]]).off, true);
});

test("a fix too rough to tell is ignored, and a worse accuracy raises the bar", () => {
  assert.equal(feed([[0, 300, 500], [5000, 300, 500]]).off, false);
  assert.equal(feed([[0, 70, 80], [5000, 75, 80]]).off, false); // 70 m off, give or take 80 m
  assert.equal(feed([[0, 90, 80], [5000, 95, 80]]).off, true);
});

test("an old fix says nothing about now", () => {
  const { s } = feed([[0, 80, 10], [1000, 80, 10]]);
  assert.equal(isOffRoute(s, 5000), true);
  assert.equal(isOffRoute(s, 60_000), false);
});

test("cooldown after a re-plan, longer waits after failures, and the server's wait wins", () => {
  let g = openGate();
  assert.equal(canReroute(g, 0), true);
  g = started(g);
  assert.equal(canReroute(g, 0), false); // one at a time
  g = succeeded(g, 1000);
  assert.equal(canReroute(g, 1000 + COOLDOWN_MS - 1), false);
  assert.equal(canReroute(g, 1000 + COOLDOWN_MS), true);
  g = failed(started(g), 50_000);
  assert.equal(g.notBefore, 50_000 + BACKOFF_MS[0]);
  g = failed(started(g), 70_000);
  assert.equal(g.notBefore, 70_000 + BACKOFF_MS[1]);
  g = failed(started(g), 100_000);
  g = failed(started(g), 200_000);
  assert.equal(g.notBefore, 200_000 + BACKOFF_MS[2]); // stays at the longest
  g = failed(started(openGate()), 0, 90);
  assert.equal(g.notBefore, 90_000);
  assert.equal(succeeded(g, 5).failures, 0);
});

test("a new heavy slowdown ahead triggers once; one behind you or known before doesn't", () => {
  const segs = buildCourse(testRoute()).segments; // S1: 0-2000 m, S2: 2000-3500 m
  assert.equal(newHeavyAhead(segs, 100, new Set(["S2"]), new Set())?.id, "S2");
  assert.equal(newHeavyAhead(segs, 100, new Set(["S2"]), new Set(["S2"])), null); // known when planned
  assert.equal(newHeavyAhead(segs, 1900, new Set(["S2"]), new Set()), null); // too close to avoid
  assert.equal(newHeavyAhead(segs, 100, new Set(["S1"]), new Set()), null); // the road you're on
});
