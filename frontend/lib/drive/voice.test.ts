// Driving mode: what's said and when.  Run: node --test lib/drive/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCourse, hazards, locate, type Course, type Hazard } from "./course.ts";
import { START, testRoute } from "./fixture.ts";
import { offset } from "./geo.ts";
import { forSpeech, hazardCalls, hazardLabel, hazardText, leadDistances, nextCall, nextHazard, spokenDistance, turnCalls, type Say } from "./voice.ts";

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

const hz = (h: Partial<Hazard>): Hazard => ({
  key: "k",
  kind: "incident",
  along: 0,
  until: 0,
  road: "Westheimer Rd",
  title: "Crash",
  lanesBlocked: 0,
  blocked: false,
  clearsInMin: null,
  chance: 1,
  ...h,
});

test("an incident on the road you're already on is announced (once, without a made-up distance) and shown", () => {
  const c = buildCourse({ ...testRoute(), segments: testRoute().segments.map((s) => ({ ...s, incident: null })), crossings: [] });
  // 100 m into North St (1500 m long), a crash comes in on it
  const hs = hazards(c, { incidents: [{ id: "new1", segment_id: "S2", kind: "crash", title: "Crash", lanes_blocked: 2, source: "houston_transtar" }] });
  const calls = hazardCalls(hs, 2100, 13, new Set());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, "Heads up: crash on North St, in the next three quarters of a mile. 2 lanes blocked.");
  assert.deepEqual(nextHazard(hs, 2100)?.distance, 0);
  // Past its end: gone
  assert.equal(hazardCalls(hs, 3600, 13, new Set()).length, 0);
  assert.equal(nextHazard(hs, 3600), null);
});

test("an incident on a long road ahead says the stretch it can be in, not a spot we don't know", () => {
  assert.equal(hazardText(hz({ road: "I-69 Southwest Fwy" }), 800, 8000), "Heads up: crash on I-69 Southwest Fwy, somewhere from half a mile to 5 miles ahead.");
  assert.equal(hazardText(hz({}), 800, 1200), "Heads up: crash on Westheimer Rd, in half a mile.");
  assert.equal(hazardText(hz({}), 0, 300), "Heads up: crash on Westheimer Rd, just ahead.");
});

test("hazard sentences: demo titles, lanes, driver reports, trains", () => {
  assert.equal(hazardText(hz({ title: "Westheimer Rd - Crash", lanesBlocked: 2 }), 2400), "Heads up: crash on Westheimer Rd, in 1.5 miles. 2 lanes blocked.");
  assert.equal(hazardText(hz({ road: "I-69 Southwest Fwy", title: "Two lanes closed", lanesBlocked: 2 }), 800), "Heads up: two lanes closed on I-69 Southwest Fwy, in half a mile.");
  assert.equal(hazardText(hz({ title: "Crash on Westheimer Rd near Post Oak" }), 800), "Heads up: crash on Westheimer Rd near Post Oak, in half a mile.");
  // Reports: no "reported", no made-up lane count
  assert.equal(hazardText(hz({ kind: "report", title: "Crash reported", lanesBlocked: 1 }), 800), "Drivers report a crash on Westheimer Rd, in half a mile.");
  assert.equal(hazardText(hz({ kind: "report", title: "Police reported", lanesBlocked: 1 }), 800), "Drivers report police on Westheimer Rd, in half a mile.");
  assert.equal(hazardText(hz({ kind: "report", title: "Object on the road", lanesBlocked: 1 }), 800), "Drivers report an object on the road on Westheimer Rd, in half a mile.");
  assert.equal(hazardText(hz({ kind: "report", demo: true, title: "Stalled car reported" }), 800), "Demo report: stalled car on Westheimer Rd, in half a mile.");
  // Trains
  const train = hz({ kind: "train", road: "Navigation Blvd", title: "Train crossing", blocked: true, clearsInMin: 0.7 });
  assert.equal(hazardText(train, 800), "A train is blocking the crossing on Navigation Blvd, in half a mile. It should clear in about a minute.");
  assert.equal(hazardText({ ...train, clearsInMin: 6 }, 800), "A train is blocking the crossing on Navigation Blvd, in half a mile. It should clear in about 6 minutes.");
});

test("a report from the demo's canned drivers isn't called real drivers; one from drivers is", () => {
  const c = buildCourse(testRoute());
  const inc = (id: string, source: string) => ({ id, segment_id: "S1", kind: "crash", title: "Crash reported", lanes_blocked: 1, source });
  const hs = hazards(c, { incidents: [inc("a", "drivers"), inc("b", "demo_drivers"), inc("c", "houston_transtar_driver_feed")] });
  assert.equal(hs.find((h) => h.key === "i:a")?.kind, "report");
  assert.equal(hs.find((h) => h.key === "i:b")?.demo, true);
  assert.equal(hs.find((h) => h.key === "i:c")?.kind, "incident");
});

test("a blocking train that clears: its planned 'certain' block isn't a pattern; the clearing is said once", () => {
  const r = testRoute();
  const c = buildCourse({ ...r, crossings: r.crossings.map((x) => ({ ...x, live: true, block_probability: 1 })) });
  const blocked = hazards(c, { crossings: [{ id: "x1", status: "blocked", time_to_clear_min: 10 }] });
  assert.equal(blocked.find((h) => h.kind === "train")?.key, "x:x1:blocked");
  const clear = hazards(c, { crossings: [{ id: "x1", status: "clear", time_to_clear_min: null }] });
  const train = clear.filter((h) => h.kind === "train");
  assert.equal(train.length, 1);
  assert.equal(train[0].cleared, true);
  // Never "trains often block it around now"
  assert.equal(hazardCalls(clear, 2000, 13, new Set()).filter((s) => /often/.test(s.text)).length, 0);
  // Only after its block was said
  assert.equal(hazardCalls(clear, 2000, 13, new Set()).filter((s) => s.key === "hazard:x:x1:cleared").length, 0);
  const said = hazardCalls(clear, 2000, 13, new Set(["hazard:x:x1:blocked"])).find((s) => s.key === "hazard:x:x1:cleared");
  assert.equal(said?.text, "The train at the crossing on North St has cleared.");
  assert.equal(nextHazard(clear.filter((h) => h.kind === "train"), 2000), null);
});

/** A route with one step of `type`/`modifier` 2 km in. */
function oneStep(type: string, modifier: string | null, instruction: string): Course {
  const r = testRoute();
  const steps = r.directions!.steps.map((s, i) => (i === 1 ? { ...s, instruction, maneuver: { ...s.maneuver, type, modifier } } : s));
  return buildCourse({ ...r, directions: { ...r.directions!, steps } });
}

function callsAlong(course: Course, speed: number): { at: number; s: Say }[] {
  const said = new Set<string>();
  const out: { at: number; s: Say }[] = [];
  for (let along = 0; along <= 2000; along += 5) {
    for (const s of turnCalls(course.steps, { along, next: 1, toNext: 2000 - along }, speed, said, "k|")) {
      said.add(s.key);
      s.covers?.forEach((k) => said.add(k));
      out.push({ at: 2000 - along, s });
    }
  }
  return out;
}

test("a road that only changes its name: said once as you reach it, never cutting anything short", () => {
  for (const [type, mod] of [["new name", null], ["continue", "straight"], ["turn", "straight"], ["exit roundabout", "right"]] as const) {
    const calls = callsAlong(oneStep(type, mod, "Continue onto Runnels St"), 13.4);
    assert.equal(calls.length, 1, `${type}: ${JSON.stringify(calls)}`);
    assert.equal(calls[0].s.text, "Continue onto Runnels St");
    assert.notEqual(calls[0].s.urgent, true);
  }
  // A real turn is still urgent
  assert.equal(callsAlong(oneStep("turn", "left", "Turn left onto North St"), 13.4).at(-1)?.s.urgent, true);
});

test("exits and freeway speeds: an extra call a quarter mile ahead, to change lanes in time", () => {
  const exit = callsAlong(oneStep("off ramp", "slight right", "Take exit 124 toward Newcastle Dr"), 29);
  assert.deepEqual(
    exit.map((c) => c.s.text),
    ["In 1 mile, take exit 124 toward Newcastle Dr", "In a quarter mile, take exit 124 toward Newcastle Dr", "Take exit 124 toward Newcastle Dr"],
  );
  assert.ok(exit[1].at <= 402 && exit[1].at >= 380, `${exit[1].at}`);
  // Any turn at 45+ mph too; a town turn at 30 mph keeps two calls
  assert.equal(callsAlong(oneStep("turn", "right", "Turn right onto Main St"), 22).length, 3);
  assert.equal(callsAlong(oneStep("turn", "right", "Turn right onto Main St"), 13.4).length, 2);
});

test("read aloud: road words in full, route numbers, slashes, compass words", () => {
  assert.equal(forSpeech("Merge onto I-69/US-59 Southwest Fwy"), "Merge onto I 69 or U.S. 59 Southwest Freeway");
  assert.equal(forSpeech("Continue on I-69/US-59 Southwest Fwy for 4 miles"), "Continue on I 69 or U.S. 59 Southwest Freeway for 4 miles");
  assert.equal(forSpeech("In half a mile, continue straight onto West Loop South Frontage Rd"), "In half a mile, continue straight onto West Loop South Frontage Road");
  assert.equal(forSpeech("Starting the route to Galleria / Uptown."), "Starting the route to Galleria, Uptown.");
  assert.equal(forSpeech("Take exit 124 toward Newcastle Dr"), "Take exit 124 toward Newcastle Drive");
  assert.equal(forSpeech("Turn left onto McKinney St, then turn right onto Smith St."), "Turn left onto McKinney Street, then turn right onto Smith Street.");
  assert.equal(forSpeech("Take the ramp toward St Joseph Pkwy"), "Take the ramp toward St Joseph Parkway");
  assert.equal(forSpeech("Turn right onto N Main St"), "Turn right onto North Main Street");
  assert.equal(forSpeech("Heads up: crash on Westheimer Rd, in 1.5 miles."), "Heads up: crash on Westheimer Road, in 1.5 miles.");
  assert.equal(forSpeech("Take exit 48B on the left toward I-45 N"), "Take exit 48B on the left toward I 45 N");
});

test("the banner's words for a hazard", () => {
  assert.equal(hazardLabel(hz({ title: "Westheimer Rd - Crash" })), "Crash on Westheimer Rd");
  assert.equal(hazardLabel(hz({ kind: "report", title: "Police reported" })), "Drivers report: police on Westheimer Rd");
  assert.equal(hazardLabel(hz({ kind: "report", demo: true, title: "Crash reported" })), "Demo report: crash on Westheimer Rd");
  assert.equal(hazardLabel(hz({ kind: "train", road: "Navigation Blvd", blocked: true })), "Train blocking Navigation Blvd");
});

test("what's next, on demand: the next turn with its distance, covering its early calls", () => {
  const c = buildCourse(testRoute());
  const s = nextCall(c.steps, locate(c, offset(START, 90, 800)), "c1|", "Work");
  assert.equal(s?.text, "In three quarters of a mile, turn left onto North St");
  assert.ok(s?.covers?.includes("c1|1:soon"));
  const end = nextCall(c.steps, locate(c, offset(offset(START, 90, 2000), 0, 700)), "c1|", "Work");
  assert.equal(end?.text, "In half a mile, Work is on the right");
});
