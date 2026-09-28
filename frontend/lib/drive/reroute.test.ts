// Driving mode: when to re-plan, and how often.  Run: node --test lib/drive/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCourse, locate } from "./course.ts";
import { CORNER, START, testRoute } from "./fixture.ts";
import { offset } from "./geo.ts";
import {
  BACKOFF_MS,
  COOLDOWN_MS,
  OFF_ROUTE_MS,
  canReroute,
  failed,
  goingForward,
  isOffRoute,
  isWrongWay,
  nearEnd,
  newHeavyAhead,
  onRoute,
  openGate,
  plannedHeavy,
  recovered,
  started,
  succeeded,
  trackOffRoute,
  trackWrongWay,
  type OffRoute,
  type WrongWay,
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
  // The road you're on: while there's a good stretch of it left (a way off it), not near its end
  assert.equal(newHeavyAhead(segs, 100, new Set(["S1"]), new Set())?.id, "S1");
  assert.equal(newHeavyAhead(segs, 600, new Set(["S1"]), new Set()), null);
});

test("one stray fix over 50 m, then steady fixes 40 m off, isn't off the route", () => {
  assert.equal(feed([[0, 51, 10], [1000, 40, 10], [2000, 42, 10], [3000, 40, 10], [4000, 41, 10], [5000, 40, 10]]).off, false);
  // Still over it at the end of the stretch: it is
  assert.equal(feed([[0, 51, 10], [1000, 40, 10], [2000, 42, 10], [3000, 40, 10], [4500, 60, 10]]).off, true);
});

test("near the end: going by the straight line to the destination, not by where you fall on the route", () => {
  // East 2 km, left, 100 m north to the door. You miss the left and keep going east 600 m.
  const r = testRoute();
  const end = offset(CORNER, 0, 100);
  const geometry = [START, offset(START, 90, 1000), CORNER, offset(CORNER, 0, 50), end];
  const c = buildCourse({ ...r, geometry, segments: [], crossings: [], directions: undefined });
  const missed = locate(c, offset(CORNER, 90, 600), 1990);
  assert.ok(missed.remainingM <= 150 && missed.off > 500); // what used to stop every re-plan
  assert.equal(nearEnd(missed.toEnd), false);
  // Far away (another city): the fix falls on the line's last meters, still not "near the end"
  assert.equal(nearEnd(locate(c, [32.78, -96.8]).toEnd), false);
  // In the parking lot next to the door
  assert.equal(nearEnd(locate(c, offset(end, 90, 80)).toEnd), true);
});

test("a run of failures ends once you're back on the route (the wait stays)", () => {
  let g = failed(started(openGate()), 1000);
  assert.equal(g.failures, 1);
  const back = recovered(g);
  assert.equal(back.failures, 0);
  assert.equal(back.notBefore, g.notBefore);
  g = started(g);
  assert.equal(recovered(g), g); // not while one is on its way
});

test("going the wrong way along the route for a few seconds re-plans; turning back clears it", () => {
  const feedWay = (fixes: [number, number | null, number, number][], road = 90) => {
    let s: WrongWay = goingForward();
    for (const [at, heading, speed, along] of fixes) s = trackWrongWay(s, { heading, speed, along, roadHeading: road, at });
    return s;
  };
  // Heading back west on an eastbound road at 20 m/s
  const back = feedWay([[0, 270, 20, 3000], [1000, 268, 20, 2980], [2000, 271, 20, 2960], [3000, 270, 20, 2940], [4000, 270, 20, 2920]]);
  assert.equal(isWrongWay(back, 4000), true);
  assert.equal(isWrongWay(back, 60_000), false); // stale
  // Not long enough, or turned back
  assert.equal(isWrongWay(feedWay([[0, 270, 20, 3000], [2000, 270, 20, 2960]]), 2000), false);
  assert.equal(isWrongWay(feedWay([[0, 270, 20, 3000], [2000, 270, 20, 2960], [3000, 95, 20, 2960], [5000, 90, 20, 3000]]), 5000), false);
  // Stopped (heading means nothing) or crossing a bend at 90 degrees: holds, doesn't start it
  assert.equal(isWrongWay(feedWay([[0, 270, 1, 3000], [5000, 270, 1, 3000]]), 5000), false);
  assert.equal(isWrongWay(feedWay([[0, 180, 20, 3000], [5000, 180, 20, 3000]]), 5000), false);
  // No heading from the device: going back along the route by more than 50 m
  assert.equal(isWrongWay(feedWay([[0, null, 20, 3000], [1000, null, 20, 2940], [3000, null, 20, 2900], [5000, null, 20, 2860]]), 5000), true);
});

test("slowdowns the route was planned with (live or predicted for then, incidents) don't count as new", () => {
  const segs = testRoute().segments.map((s, i) => ({ ...s, id: `S${i + 1}`, incident: null }));
  assert.deepEqual([...plannedHeavy(segs)], []);
  assert.deepEqual([...plannedHeavy([{ ...segs[0], predicted_congestion: 0.7 }, segs[1]])], ["S1"]);
  assert.deepEqual([...plannedHeavy([segs[0], { ...segs[1], congestion: 0.65 }])], ["S2"]);
  assert.deepEqual([...plannedHeavy([testRoute().segments[1]])], ["S2"]); // has an incident
});
