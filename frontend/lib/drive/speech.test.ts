// Driving mode: speaking one line at a time.  Run: node --test lib/drive/*.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCourse } from "./course.ts";
import { testRoute } from "./fixture.ts";
import { simStep, speedAt } from "./simulate.ts";
import { REPEAT_MS, Speaker, type Utterance } from "./speech.ts";

/** A fake synth: records what it's asked to say; `finish()` ends the current line. */
function fake() {
  const spoken: string[] = [];
  let current: Utterance | null = null;
  let cancels = 0;
  const synth = {
    speak(u: Utterance) {
      spoken.push(u.text);
      current = u;
    },
    cancel() {
      cancels++;
      const u = current;
      current = null;
      u?.onerror?.();
    },
  };
  const finish = () => {
    const u = current;
    current = null;
    u?.onend?.();
  };
  return { synth, spoken, finish, cancels: () => cancels };
}

const make = (text: string): Utterance => ({ text, onend: null, onerror: null });

test("one line at a time, in order", () => {
  const f = fake();
  const s = new Speaker(f.synth, make);
  s.say({ text: "a" });
  s.say({ text: "b" });
  assert.deepEqual(f.spoken, ["a"]);
  f.finish();
  assert.deepEqual(f.spoken, ["a", "b"]);
  f.finish();
  assert.equal(s.busy, false);
});

test("a turn goes first and cuts short a heads-up, which is read again right after it (once)", () => {
  const f = fake();
  const s = new Speaker(f.synth, make);
  s.say({ text: "Heads up: crash" });
  s.say({ text: "Rail crossing" });
  s.say({ text: "Turn left", urgent: true });
  assert.deepEqual(f.spoken, ["Heads up: crash", "Turn left"]);
  f.finish();
  assert.deepEqual(f.spoken, ["Heads up: crash", "Turn left", "Heads up: crash"]);
  // Cut short a second time: not again
  s.say({ text: "Turn right", urgent: true });
  f.finish();
  f.finish();
  assert.deepEqual(f.spoken, ["Heads up: crash", "Turn left", "Heads up: crash", "Turn right", "Rail crossing"]);
});

test("an early call cut short by its own turn call isn't read again after it", () => {
  const f = fake();
  const s = new Speaker(f.synth, make);
  s.say({ text: "In a quarter mile, take exit 124", group: "turn" });
  s.say({ text: "Take exit 124", urgent: true, group: "turn" });
  f.finish();
  f.finish();
  assert.deepEqual(f.spoken, ["In a quarter mile, take exit 124", "Take exit 124"]);
});

test("two different turns with the same words are both said; lines are told apart by key", () => {
  let now = 0;
  const f = fake();
  const s = new Speaker(f.synth, make, () => now);
  assert.equal(s.say({ text: "Keep left at the fork", urgent: true, group: "turn", key: "c|3:now" }), true);
  f.finish();
  now = 15_000;
  assert.equal(s.say({ text: "Keep left at the fork", urgent: true, group: "turn", key: "c|5:now" }), true);
  f.finish();
  assert.deepEqual(f.spoken, ["Keep left at the fork", "Keep left at the fork"]);
  // The same key again is still a repeat
  assert.equal(s.say({ text: "Keep left at the fork", key: "c|5:now" }), false);
});

test("with too many waiting, heads-ups give way before a turn call", () => {
  const f = fake();
  const s = new Speaker(f.synth, make);
  s.say({ text: "Starting the route to X. Head east on Main St" });
  s.say({ text: "In a quarter mile, turn left onto North St", group: "turn" });
  s.say({ text: "Heads up: crash on A, in half a mile.", group: "hazard:1" });
  s.say({ text: "Heads up: stall on B, in 1 mile.", group: "hazard:2" });
  s.say({ text: "Rail crossing on C in 1 mile.", group: "hazard:3" });
  s.say({ text: "Road closure on D in 1.5 miles.", group: "hazard:4" });
  for (let i = 0; i < 6; i++) f.finish();
  assert.ok(f.spoken.includes("In a quarter mile, turn left onto North St"), JSON.stringify(f.spoken));
  assert.ok(!f.spoken.includes("Road closure on D in 1.5 miles."), JSON.stringify(f.spoken));
});

test("a browser that refuses to speak: says so once, takes nothing more until unblocked", () => {
  const spoken: string[] = [];
  let current: Utterance | null = null;
  const synth = {
    speak(u: Utterance) {
      spoken.push(u.text);
      current = u;
      queueMicrotask(() => current?.onerror?.({ error: "not-allowed" }));
    },
    cancel() {},
  };
  const s = new Speaker(synth, make);
  let told = 0;
  s.onBlocked = () => told++;
  assert.equal(s.say({ text: "Turn left", urgent: true }), true);
  return Promise.resolve().then(() => {
    assert.equal(told, 1);
    assert.equal(s.blocked, true);
    assert.equal(s.busy, false);
    assert.equal(s.say({ text: "Turn right", urgent: true }), false); // not used up: said again later
    s.unblock();
    assert.equal(s.say({ text: "Turn right", urgent: true }), true);
    assert.deepEqual(spoken, ["Turn left", "Turn right"]);
  });
});

test("a turn doesn't cut short another turn", () => {
  const f = fake();
  const s = new Speaker(f.synth, make);
  s.say({ text: "Turn left", urgent: true });
  s.say({ text: "Rerouting", urgent: true });
  assert.deepEqual(f.spoken, ["Turn left"]);
  f.finish();
  assert.deepEqual(f.spoken, ["Turn left", "Rerouting"]);
});

test("a newer line in the same group replaces one waiting", () => {
  const f = fake();
  const s = new Speaker(f.synth, make);
  s.say({ text: "Heads up" });
  s.say({ text: "In half a mile, turn left", group: "turn" });
  s.say({ text: "Turn left", group: "turn" });
  f.finish();
  f.finish();
  assert.deepEqual(f.spoken, ["Heads up", "Turn left"]);
});

test("the same words aren't repeated within a while", () => {
  let now = 0;
  const f = fake();
  const s = new Speaker(f.synth, make, () => now);
  assert.equal(s.say({ text: "Rerouting" }), true);
  f.finish();
  now = 5000;
  assert.equal(s.say({ text: "Rerouting" }), false);
  now = REPEAT_MS + 1;
  assert.equal(s.say({ text: "Rerouting" }), true);
});

test("muted, or no speech at all: silent, no errors", () => {
  const f = fake();
  const s = new Speaker(f.synth, make);
  s.muted = true;
  assert.equal(s.say({ text: "Turn left" }), false);
  assert.deepEqual(f.spoken, []);
  const none = new Speaker(null, null);
  assert.equal(none.supported, false);
  assert.equal(none.say({ text: "Turn left", urgent: true }), false);
  none.cancel();
});

test("cancel stops talking and drops what's waiting", () => {
  const f = fake();
  const s = new Speaker(f.synth, make);
  s.say({ text: "a" });
  s.say({ text: "b" });
  s.cancel();
  assert.equal(f.cancels(), 1);
  assert.equal(s.busy, false);
  s.say({ text: "c" });
  assert.deepEqual(f.spoken, ["a", "c"]);
});

test("a synth that throws doesn't jam the queue", () => {
  const s = new Speaker(
    {
      speak() {
        throw new Error("not allowed");
      },
      cancel() {},
    },
    make,
  );
  s.say({ text: "a" });
  s.say({ text: "b" });
  assert.equal(s.busy, false);
});

test("simulated drive: moves along at the road's speed, times the demo factor, and stops at the end", () => {
  const course = buildCourse(testRoute());
  const v = speedAt(course, 100); // 2000 m in 150 s
  assert.ok(Math.abs(v - 2000 / 150) < 0.01);
  const a = simStep(course, 100, 1, 1);
  assert.ok(Math.abs(a.along - (100 + v)) < 0.01);
  assert.equal(Math.round(a.heading), 90);
  const b = simStep(course, 100, 1, 4);
  assert.ok(Math.abs(b.along - (100 + 4 * v)) < 0.01);
  const end = simStep(course, course.line.length - 5, 10, 4);
  assert.equal(end.done, true);
  assert.equal(end.along, course.line.length);
});
