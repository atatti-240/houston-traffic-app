/**
 * Speaking driving directions with the browser's speech synthesis, one line at a time:
 *  - it never talks over itself: lines wait their turn, an urgent one (a turn you're reaching) goes first and cuts
 *    short a heads-up being read,
 *  - a newer line in the same group replaces one still waiting (an early call for a turn that's now due),
 *  - the same words aren't said twice within REPEAT_MS,
 *  - muted or without speech (some browsers have none) it says nothing and nothing breaks.
 * The synth is passed in, so this is unit-tested with a fake (`node --test`); `browserSpeaker()` uses the real one.
 */

export interface Line {
  text: string;
  urgent?: boolean;
  group?: string;
}

/** The bits of window.speechSynthesis used here. */
export interface Synth {
  speak(u: Utterance): void;
  cancel(): void;
}

export interface Utterance {
  text: string;
  lang?: string;
  onend: ((e?: unknown) => void) | null;
  onerror: ((e?: unknown) => void) | null;
}

export const REPEAT_MS = 30_000;
const MAX_WAITING = 4;

export class Speaker {
  private waiting: Line[] = [];
  private current: { line: Line; token: number } | null = null;
  private token = 0;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private recent = new Map<string, number>();
  private readonly synth: Synth | null;
  private readonly make: ((text: string) => Utterance) | null;
  private readonly now: () => number;
  muted = false;

  constructor(synth: Synth | null, make: ((text: string) => Utterance) | null, now: () => number = () => Date.now()) {
    this.synth = synth;
    this.make = make;
    this.now = now;
  }

  get supported(): boolean {
    return !!this.synth && !!this.make;
  }

  /** Queue a line. False when it won't be said (muted, no speech, said just now). */
  say(line: Line): boolean {
    if (!this.supported || this.muted || !line.text) return false;
    const t = this.now();
    const last = this.recent.get(line.text);
    if (last !== undefined && t - last < REPEAT_MS) return false;
    if (line.group) this.waiting = this.waiting.filter((w) => w.group !== line.group);
    if (line.urgent) {
      this.waiting.unshift(line);
      // A heads-up being read gives way to a turn
      if (this.current && !this.current.line.urgent) this.interrupt();
    } else {
      this.waiting.push(line);
      while (this.waiting.length > MAX_WAITING) this.waiting.splice(this.waiting.findIndex((w) => !w.urgent), 1);
    }
    this.recent.set(line.text, t);
    for (const [k, at] of this.recent) if (t - at >= REPEAT_MS) this.recent.delete(k);
    this.pump();
    return true;
  }

  /** Stop talking and forget everything waiting. */
  cancel(): void {
    this.waiting = [];
    this.finish();
    try {
      this.synth?.cancel();
    } catch {}
  }

  get busy(): boolean {
    return this.current !== null;
  }

  private interrupt() {
    this.finish();
    try {
      this.synth?.cancel();
    } catch {}
  }

  private finish() {
    this.current = null;
    this.token++;
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private pump() {
    if (this.current || !this.waiting.length || !this.synth || !this.make) return;
    const line = this.waiting.shift() as Line;
    const token = ++this.token;
    this.current = { line, token };
    const done = () => {
      if (this.current?.token !== token) return;
      this.finish();
      this.pump();
    };
    // Some engines never say they're done: move on after about as long as the line takes
    this.watchdog = setTimeout(done, 2500 + line.text.length * 90);
    try {
      const u = this.make(line.text);
      u.lang = "en-US";
      u.onend = done;
      u.onerror = done;
      this.synth.speak(u);
    } catch {
      done();
    }
  }
}

/** A speaker using this browser's speech, or a silent one where there's none. */
export function browserSpeaker(): Speaker {
  const w = typeof window === "undefined" ? null : (window as unknown as { speechSynthesis?: Synth; SpeechSynthesisUtterance?: new (t: string) => Utterance });
  const synth = w && "speechSynthesis" in w && w.speechSynthesis ? w.speechSynthesis : null;
  const U = w?.SpeechSynthesisUtterance;
  return new Speaker(synth, synth && typeof U === "function" ? (t) => new U(t) : null);
}

/** Some phones (iOS) only let a page speak after it spoke inside a tap: call this from the tap (Start, unmute). */
export function primeSpeech(): void {
  try {
    const w = window as unknown as { speechSynthesis?: Synth; SpeechSynthesisUtterance?: new (t: string) => Utterance & { volume?: number } };
    if (!w.speechSynthesis || typeof w.SpeechSynthesisUtterance !== "function") return;
    const u = new w.SpeechSynthesisUtterance(" ");
    u.volume = 0;
    w.speechSynthesis.speak(u);
  } catch {}
}

const MUTE_KEY = "blindspot.voiceMuted";

export function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {}
}
