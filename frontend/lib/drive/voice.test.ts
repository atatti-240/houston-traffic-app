// Driving mode: what's said and when.  Run: node --test lib/drive/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCourse, hazards, locate, type Course } from "./course.ts";
import { START, testRoute } from "./fixture.ts";
import { offset } from "./geo.ts";
import { hazardCalls, leadDistances, spokenDistance, turnCalls, type Say } from "./voice.ts";

test("spoken distances round to what people say", () => {
  assert.equal(spokenDistance(30), "100 feet");
  assert.equal(spokenDistance(91), "300 feet");
  assert.equal(spokenDistance(250), "800 feet");
  assert.equal(spokenDistance(450), "a quarter mile");
  assert.equal(spokenDistance(800), "half a mile");
  assert.equal(spokenDistance(1300), "three quarters of a mile");
  assert.equal(spokenDistance(1609), "1 mile");
  assert.equal(spokenDistance(2400), "1.5 miles");
  assert.equal(spokenDistance(8000), "5 miles");
});

test("lead distances grow with speed, within limits", () => {
  const slow = leadDistances(10);
  const fast = leadDistances(30);
  assert.ok(fast.far > slow.far && fast.near > slow.near);
  assert.equal(slow.far, 402); // a quarter mile in town
  assert.equal(leadDistances(20).far, 805);
  assert.equal(fast.far, 1609); // a mile on the freeway
  assert.equal(leadDistances(100).far, 1609);
  // Called just inside the distance: said as that distance
  assert.equal(spokenDistance(slow.far - 20), "a quarter mile");
  assert.equal(spokenDistance(805 - 30), "half a mile");
  assert.equal(spokenDistance(1609 - 40), "1 mile");
  assert.equal(leadDistances(null).near, leadDistances(13.4).near);
});

/** Drive the test route every `stepM` meters, saying what's due; returns what was said. */
function drive(course: Course, speed: number, stepM = 20, toName = "Work"): Say[] {
  const said = new Set<string>();
  const out: Say[] = [];
  let hint: number | null = null;
  for (let d = 0; d <= course.line.length; d += stepM) {
    const pt = d <= 2000 ? offset(START, 90, d) : offset(offset(START, 90, 2000), 0, d - 2000);
    const p = locate(course, pt, hint);
    hint = p.along;
    for (const s of [...turnCalls(course.steps, p, speed, said, "c1:", toName), ...hazardCalls(hazards(course), p.along, speed, said)]) {
      said.add(s.key);
      s.covers?.forEach((k) => said.add(k));
      out.push(s);
    }
  }
  return out;
}

test("each turn is called early and again as you reach it, once each", () => {
  const course = buildCourse(testRoute());
  const said = drive(course, 13.4);
  const texts = said.map((s) => s.text);
  const early = texts.filter((t) => /^In .*, turn left onto North St$/.test(t));
  const now = texts.filter((t) => t === "Turn left onto North St");
  assert.equal(early.length, 1, texts.join(" | "));
  assert.equal(now.length, 1, texts.join(" | "));
  assert.ok(texts.indexOf(early[0]) < texts.indexOf(now[0]));
  assert.equal(said.find((s) => s.text === now[0])?.urgent, true);
  // The destination: called early by name, and the side it's on
  assert.ok(texts.some((t) => /^In .*, Work is on the right$/.test(t)), texts.join(" | "));
  // No key twice
  assert.equal(new Set(said.map((s) => s.key)).size, said.length);
});

test("hazards get one heads-up each, before you reach them", () => {
  const course = buildCourse(testRoute());
  const said = drive(course, 13.4).map((s) => s.text);
  assert.equal(said.filter((t) => t.startsWith("Heads up: crash on North St")).length, 1, said.join(" | "));
  assert.equal(said.filter((t) => t.startsWith("Rail crossing on North St")).length, 1, said.join(" | "));
  assert.match(said.find((t) => t.startsWith("Heads up")) ?? "", /1 lane blocked\.$/);
});

test("a turn reached before its early call is said once, as the turn", () => {
  const course = buildCourse(testRoute());
  const said = new Set<string>();
  const p = locate(course, offset(START, 90, 1990));
  const calls = turnCalls(course.steps, p, 13.4, said, "c1:");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, "Turn left onto North St");
  calls[0].covers?.forEach((k) => said.add(k));
  said.add(calls[0].key);
  assert.deepEqual(turnCalls(course.steps, locate(course, offset(START, 90, 1995)), 13.4, said, "c1:"), []);
});

test("a turn that's already close when it comes up gets one call, not two in a row", () => {
  const course = buildCourse(testRoute());
  const said = new Set<string>();
  const { near } = leadDistances(13.4);
  // Right after the start, the corner is just outside the turn call's distance
  const p = locate(course, offset(START, 90, 2000 - near * 1.3));
  assert.deepEqual(turnCalls(course.steps, p, 13.4, said, "c1:"), []);
  const q = locate(course, offset(START, 90, 2000 - near + 5));
  assert.equal(turnCalls(course.steps, q, 13.4, said, "c1:")[0].text, "Turn left onto North St");
});

test("two turns close together are said as one", () => {
  const r = testRoute();
  // The destination right after the corner
  const steps = r.directions!.steps;
  const course = buildCourse({
    ...r,
    geometry: r.geometry.filter((_, i) => i <= 21),
    directions: { ...r.directions!, steps: [steps[0], steps[1], { ...steps[2], maneuver: { ...steps[2].maneuver, location: r.geometry[21] } }] },
  });
  const p = locate(course, offset(START, 90, 1950));
  const calls = turnCalls(course.steps, p, 13.4, new Set(), "c1:", "Work");
  assert.equal(calls[0].text, "Turn left onto North St, then Work is on the right");
});

test("a new course (a re-plan) calls its turns afresh; hazards stay said", () => {
  const course = buildCourse(testRoute());
  const said = new Set<string>(["c1:1:soon", "hazard:x:x1"]);
  const p = locate(course, offset(START, 90, 1700));
  assert.equal(turnCalls(course.steps, p, 13.4, said, "c1:").length, 0);
  assert.equal(turnCalls(course.steps, p, 13.4, said, "c2:").length, 1);
});

test("no turn-by-turn: nothing to call, and no errors", () => {
  const course = buildCourse(testRoute({ withSteps: false }));
  const p = locate(course, offset(START, 90, 1700));
  assert.equal(p.next, null);
  assert.deepEqual(turnCalls(course.steps, p, 13.4, new Set(), "c1:"), []);
});
