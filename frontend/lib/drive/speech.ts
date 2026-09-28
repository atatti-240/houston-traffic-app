/**
 * Speaking driving directions with the browser's speech synthesis, one line at a time:
 *  - it never talks over itself: lines wait their turn, an urgent one (a turn you're reaching) goes first and cuts
 *    short a heads-up being read, which is then read again once (after the urgent lines; an early turn call it cuts
 *    short is just dropped),
 *  - a newer line in the same group replaces one still waiting (an early call for a turn that's now due),
 *  - with too many waiting, a heads-up gives way before a turn call does,
 *  - the same line (its key, or its words when it has none) isn't said twice within REPEAT_MS,
 *  - muted or without speech (some browsers have none) it says nothing and nothing breaks; when the browser refuses
 *    to speak (no tap yet), it says so (`onBlocked`) and takes nothing more until `unblock()`.
 * The synth is passed in, so this is unit-tested with a fake (`node --test`); `browserSpeaker()` uses the real one.
 */

export interface Line {
  text: string;
  urgent?: boolean;
  group?: string;
  /** Tells lines apart (two forks both "Keep left at the fork"); without one, the words do */
  key?: string;
  /** Already cut short once: not again */
  retried?: boolean;
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
  /** The browser refused to speak (it wants a tap first) */
  blocked = false;
  onBlocked: (() => void) | null = null;

  constructor(synth: Synth | null, make: ((text: string) => Utterance) | null, now: () => number = () => Date.now()) {
    this.synth = synth;
    this.make = make;
    this.now = now;
  }

  get supported(): boolean {
    return !!this.synth && !!this.make;
  }

  /** Queue a line. False when it won't be said (muted, no speech, blocked, said just now). */
  say(line: Line): boolean {
    if (!this.supported || this.muted || this.blocked || !line.text) return false;
    const t = this.now();
    const id = line.key ?? line.text;
    const last = this.recent.get(id);
    if (last !== undefined && t - last < REPEAT_MS) return false;
    if (line.group) this.waiting = this.waiting.filter((w) => w.group !== line.group);
    if (line.urgent) {
      this.waiting.unshift(line);
      // A heads-up being read gives way to a turn, and is read again right after the urgent lines (not an early
      // call for a turn: the turn being called now replaces it)
      const cut = this.current && !this.current.line.urgent ? this.current.line : null;
      if (cut) {
        this.interrupt();
        if (!cut.retried && cut.group !== "turn" && (cut.group === undefined || cut.group !== line.group)) {
          const at = this.waiting.findIndex((w) => !w.urgent);
          this.waiting.splice(at < 0 ? this.waiting.length : at, 0, { ...cut, retried: true });
        }
      }
    } else this.waiting.push(line);
    while (this.waiting.length > MAX_WAITING) {
      // The newest heads-up goes first, a turn call (or "Rerouting") only when there's nothing else
      let i = -1;
      for (let k = this.waiting.length - 1; k >= 0 && i < 0; k--) {
        const w = this.waiting[k];
        if (!w.urgent && w.group !== "turn" && w.group !== "reroute") i = k;
      }
      if (i < 0) i = this.waiting.findIndex((w) => !w.urgent);
      this.waiting.splice(i < 0 ? this.waiting.length - 1 : i, 1);
    }
    this.recent.set(id, t);
    for (const [k, at] of this.recent) if (t - at >= REPEAT_MS) this.recent.delete(k);
    this.pump();
    return true;
  }

  /** A tap happened: try speaking again. */
  unblock(): void {
    this.blocked = false;
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
      u.onerror = (e?: unknown) => {
        // Chrome after a reload, iOS before a tap: nothing will be said until the page gets a tap
        if ((e as { error?: string } | undefined)?.error === "not-allowed" && this.current?.token === token) {
          this.blocked = true;
          this.waiting = [];
          this.finish();
          this.onBlocked?.();
          return;
        }
        done();
      };
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
