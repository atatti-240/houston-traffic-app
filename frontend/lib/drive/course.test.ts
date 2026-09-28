// Driving mode: geometry, progress along a route, what's ahead.  Run: node --test lib/drive/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { ARRIVE_M, buildCourse, hazards, locate, sameRoad, timeAt } from "./course.ts";
import { CORNER, END, START, testRoute } from "./fixture.ts";
import { bearing, distanceM, measure, offset, pointAt, project } from "./geo.ts";

const near = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

test("geo: distance, bearing, offset agree", () => {
  const p = offset(START, 90, 1000);
  near(distanceM(START, p), 1000, 0.5);
  near(bearing(START, p), 90, 0.1);
  near(bearing(p, START), 270, 0.1);
});

test("geo: projecting onto a line gives meters along and off", () => {
  const line = measure([START, CORNER, END]);
  near(line.length, 3500, 1);
  const q = project(line, offset(offset(START, 90, 700), 0, 40));
  assert.ok(q);
  near(q.along, 700, 1);
  near(q.off, 40, 0.5);
  const at = pointAt(line, 2500);
  near(distanceM(at.at, offset(CORNER, 0, 500)), 0, 1);
  near(at.heading, 0, 0.5);
});

test("course: turns placed along the line, in order", () => {
  const c = buildCourse(testRoute());
  assert.equal(c.steps.length, 3);
  near(c.steps[0].along, 0, 0.1);
  near(c.steps[1].along, 2000, 1);
  near(c.steps[2].along, c.line.length, 0.1);
  assert.equal(c.segments.length, 2);
  near(c.segments[0].from, 0, 1);
  near(c.segments[0].to, 2000, 1);
  assert.equal(c.segments[0].speedLimitMph, 45);
  assert.equal(c.segments[1].speedLimitMph, null); // missing: unknown, never made up
  assert.equal(c.crossings.length, 1);
  near(c.crossings[0].along, 2500, 1);
});

test("course: the time profile adds up to the traffic-aware total", () => {
  const c = buildCourse(testRoute({ totalMin: 9 }));
  near(timeAt(c, 0), 0, 0.01);
  near(timeAt(c, c.line.length), 540, 0.01);
  // Steps: 150 s of 270 s on the first 2000 m
  near(timeAt(c, 2000), (150 / 270) * 540, 0.5);
  const flat = buildCourse(testRoute({ withSteps: false, totalMin: 7 }));
  near(timeAt(flat, flat.line.length / 2), 210, 0.5);
});

test("locate: next turn and the distance to it count down as you drive", () => {
  const c = buildCourse(testRoute());
  const p1 = locate(c, offset(START, 90, 500));
  assert.equal(p1.next, 1);
  near(p1.toNext, 1500, 1);
  near(p1.remainingM, 3000, 1);
  assert.equal(p1.segment?.id, "S1");
  const p2 = locate(c, offset(START, 90, 1800), p1.along);
  near(p2.toNext, 200, 1);
  assert.ok(p2.remainingS < p1.remainingS);
  // Past the corner: the destination is next
  const p3 = locate(c, offset(CORNER, 0, 100), p2.along);
  assert.equal(p3.next, 2);
  assert.equal(c.steps[p3.next].step.maneuver.type, "arrive");
  assert.equal(p3.segment?.id, "S2");
  assert.equal(p3.arrived, false);
  const p4 = locate(c, offset(END, 180, ARRIVE_M - 10), p3.along);
  assert.equal(p4.arrived, true);
});

test("locate: off the route by 80 m reads as 80 m off", () => {
  const c = buildCourse(testRoute());
  const p = locate(c, offset(offset(START, 90, 1000), 180, 80), 900);
  near(p.off, 80, 1);
  assert.equal(p.segment, null); // too far off to say which road you're on
});

test("locate: a hint keeps you on your part of a line that passes near itself", () => {
  // Out 1 km east and back west 20 m to the north: the way back passes 20 m from the way out
  const a = START;
  const b = offset(a, 90, 1000);
  const c2 = offset(b, 0, 20);
  const d = offset(a, 0, 20);
  const route = { ...testRoute(), geometry: [a, b, c2, d], segments: [], crossings: [], directions: undefined };
  const c = buildCourse(route);
  const mid = offset(a, 90, 500);
  const early = locate(c, offset(mid, 0, 12), 400); // nearer the way back, but you're on the way out
  near(early.along, 500, 2);
  const late = locate(c, offset(mid, 0, 8), 1500); // nearer the way out, but you're on the way back
  near(late.along, 1520, 2);
});

test("hazards: crossings with a real chance of a train, incidents, and live changes", () => {
  const c = buildCourse(testRoute());
  const hs = hazards(c);
  assert.deepEqual(
    hs.map((h) => [h.kind, h.key]),
    [
      ["incident", "i:inc1"],
      ["train", "x:x1"],
    ],
  );
  near(hs[0].along, 2000, 1); // at the start of North St
  // A train blocking it now (live) and a driver report that came in after the plan
  const live = hazards(c, {
    crossings: [{ id: "x1", status: "blocked", time_to_clear_min: 6 }],
    incidents: [{ id: "rep9", segment_id: "S1", kind: "stall", title: "Stalled car", lanes_blocked: 0, source: "drivers" }],
  });
  const train = live.find((h) => h.kind === "train");
  assert.equal(train?.blocked, true);
  assert.equal(train?.key, "x:x1:blocked");
  assert.equal(train?.clearsInMin, 6);
  assert.equal(live.find((h) => h.key === "i:rep9")?.kind, "report");
  // An unlikely train is no heads-up
  const quiet = buildCourse({ ...testRoute(), crossings: testRoute().crossings.map((x) => ({ ...x, block_probability: 0.05 })) });
  assert.equal(hazards(quiet).filter((h) => h.kind === "train").length, 0);
});

test("course: a speed limit that isn't a sensible number is unknown", () => {
  const r = testRoute();
  r.segments[0] = { ...r.segments[0], speed_limit_mph: "45" } as unknown as typeof r.segments[0];
  assert.equal(buildCourse(r).segments[0].speedLimitMph, null);
});

test("course: speed limits as roadrules sends them (whole mph or null) are read, never made up", () => {
  // Over the wire: a toll freeway posted 65, then a freeway OpenStreetMap has no limit for
  const r = testRoute();
  r.segments[0] = { ...r.segments[0], road_class: "freeway", speed_limit_mph: 65, toll: true };
  r.segments[1] = { ...r.segments[1], road_class: "freeway", speed_limit_mph: null, toll: false };
  const c = buildCourse(JSON.parse(JSON.stringify(r)));
  assert.deepEqual(
    c.segments.map((s) => [s.id, s.speedLimitMph]),
    [
      ["S1", 65],
      ["S2", null],
    ],
  );
  // Where you are: the sign shows 65 on S1 and nothing on S2 (not a guess from its road class or free-flow speed)
  const p1 = locate(c, offset(START, 90, 500));
  assert.equal(p1.segment?.speedLimitMph, 65);
  const p2 = locate(c, offset(CORNER, 0, 300), p1.along);
  assert.equal(p2.segment?.id, "S2");
  assert.equal(p2.segment?.speedLimitMph, null);
  // Off our roads (on the way to them): no segment, so no limit
  assert.equal(locate(c, offset(offset(START, 90, 500), 180, 200)).segment, null);
});

test("sameRoad: a freeway by its route number (not its frontage road), a street by its name", () => {
  assert.equal(sameRoad("I-69 Southwest Fwy", "I-69/US-59 Southwest Fwy"), true);
  assert.equal(sameRoad("I-69 Southwest Fwy", "Southwest Fwy Frontage Rd"), false);
  assert.equal(sameRoad("I-69 Southwest Fwy", "Smith St"), false);
  assert.equal(sameRoad("I-610 West Loop", "I-610 West Loop South Fwy"), true);
  assert.equal(sameRoad("I-610 West Loop", "West Loop South Frontage Rd"), false);
  assert.equal(sameRoad("BW-8 Sam Houston Tollway", "BW-8 Sam Houston Tollway"), true);
  assert.equal(sameRoad("SH-288 South Fwy", "TX-288 South Fwy"), true);
  assert.equal(sameRoad("Westheimer Rd", "Westheimer Rd"), true);
  assert.equal(sameRoad("Lawndale / Cullen Blvd", "Cullen Blvd"), true);
  assert.equal(sameRoad("Lawndale / Cullen Blvd", "Lawndale St"), true);
  assert.equal(sameRoad("Main St", "Smith St"), false);
  assert.equal(sameRoad("Westheimer Rd", ""), false); // a ramp
});

test("locate: a freeway's limit only once the directions have you on it, not on the street beside it or its exit", () => {
  // Smith St for 1 km under a freeway segment (posted 60) whose shape runs along the whole first leg, then the merge,
  // the exit ramp at 1600 m, the turn onto North St
  const r = testRoute();
  const [depart, turn, arrive] = r.directions!.steps;
  const at = (m: number) => offset(START, 90, m);
  const onto = (instruction: string, type: string, m: number, road: string, distance_m: number) => ({
    ...depart,
    instruction,
    road,
    distance_m,
    maneuver: { ...depart.maneuver, type, modifier: "slight right", location: at(m) },
  });
  r.directions!.steps = [
    { ...depart, instruction: "Head east on Smith St", road: "Smith St", distance_m: 1000 },
    onto("Merge onto I-69/US-59 Southwest Fwy", "merge", 1000, "I-69/US-59 Southwest Fwy", 600),
    onto("Take exit 124", "off ramp", 1600, "", 400),
    turn,
    arrive,
  ];
  r.segments[0] = { ...r.segments[0], name: "I-69 Southwest Fwy", road_class: "freeway", speed_limit_mph: 60 };
  const c = buildCourse(r);
  assert.equal(c.segments[0].onLine, true);
  const p1 = locate(c, at(500));
  assert.equal(p1.segment, null); // on Smith St: no 60
  const p2 = locate(c, at(1300), p1.along);
  assert.equal(p2.segment?.speedLimitMph, 60);
  const p3 = locate(c, at(1800), p2.along);
  assert.equal(p3.segment, null); // on the exit ramp
  const p4 = locate(c, offset(CORNER, 0, 300), p3.along);
  assert.equal(p4.segment?.id, "S2");
  // Without turn-by-turn there's nothing to check the road against: the segment under you
  const flat = buildCourse({ ...r, directions: testRoute({ withSteps: false }).directions });
  assert.equal(locate(flat, at(500)).segment?.speedLimitMph, 60);
});
