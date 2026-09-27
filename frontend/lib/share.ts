/** Share ETA: make a read-only link for a route (POST /shares), read what a link shows (GET /shares/{id}),
 * and hand a link to the phone's share sheet or the clipboard. */

import { API_URL, call } from "./api";
import { fmtDayTime, fmtTime } from "./format";
import type { LatLngTuple } from "./types";

export interface ShareRequest {
  segment_ids: string[];
  /** Planned leave time; one already past means now */
  depart_at?: string;
  origin_name?: string;
  destination_name?: string;
  /** Destination pin (e.g. a shop near the route's end) */
  destination?: { lat: number; lng: number };
}

export interface ShareMade {
  id: string;
  depart_at: string;
  eta: string;
  main_road: string;
  expires_in_min: number;
}

/** What a link shows. Times are simulated Houston time, like everywhere else. */
export interface SharedTrip {
  origin_name: string;
  destination_name: string;
  main_road: string;
  miles: number;
  geometry: LatLngTuple[];
  end: LatLngTuple;
  depart_at: string;
  /** ETA when the link was made */
  shared_eta: string;
  /** ETA re-checked just now (or the last one, see `checked`) */
  eta: string;
  status: "not_left" | "on_the_way" | "arrived";
  /** False: not re-checked (the trip ended a while ago, or the road map changed) */
  checked: boolean;
  now: string;
  shared_at: string;
  expires_in_min: number;
}

const TIMEOUT_MS = 15000;
const MAX_NAME = 200; // the API's cap on a place name (it keeps the first 80 characters)

/** A request the API turned down, with its status (call() in api.ts keeps only the message). */
class ShareRefused extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A place name the API takes: one line, at most MAX_NAME characters, counted like the API counts
 * them (by code point, so an emoji isn't cut in half). */
function fitName(name: string | undefined): string | undefined {
  return name === undefined ? undefined : Array.from(name.replace(/\s+/g, " ").trim()).slice(0, MAX_NAME).join("");
}

/** POST /shares with the names cut to fit. A refusal keeps its status, for describeCreateError. */
async function create(body: ShareRequest): Promise<ShareMade> {
  const res = await fetch(`${API_URL}/shares`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, origin_name: fitName(body.origin_name), destination_name: fitName(body.destination_name) }),
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    // The message is for debugging only: a validation error's detail is a list of field errors.
    const detail = await res.json().then((j) => j?.detail, () => null);
    throw new ShareRefused(res.status, typeof detail === "string" ? detail : res.statusText);
  }
  return res.json();
}

export const shareApi = {
  create,
  get: (id: string) => call<SharedTrip>(`/shares/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) }),
};

export function shareUrl(id: string): string {
  return `${window.location.origin}/share/${encodeURIComponent(id)}`;
}

/** The API's 404 for an unknown, malformed or expired link. */
export function isGone(e: unknown): boolean {
  return e instanceof Error && /link expired|not found/i.test(e.message);
}

/** Network trouble in the app's words, else the API's message. */
export function describeShareError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/failed to fetch|networkerror|load failed|timed? ?out|aborted/i.test(msg)) return "Can't reach BlindSpot right now.";
  return msg;
}

/** What the Share button says when a link couldn't be made: our words, whatever the API said. */
export function describeCreateError(e: unknown): string {
  if (!(e instanceof ShareRefused)) return `Couldn't make a link: ${describeShareError(e)}`;
  if (e.status === 429) return "Couldn't make a link: Too many share links from here. Try again in a while.";
  if (e.status < 500) return "Couldn't make a link for this trip. Try planning it again.";
  return "Couldn't make a link right now. Try again in a bit.";
}

/** A time, with the weekday when it isn't on `ref`'s day. */
export function timeOn(iso: string, ref: string): string {
  return iso.slice(0, 10) === ref.slice(0, 10) ? fmtTime(iso) : fmtDayTime(iso);
}

/** The message that goes with the link. */
export function shareText(made: ShareMade, to: string, now: string | undefined): string {
  const eta = timeOn(made.eta, made.depart_at);
  if (now && made.depart_at > now) return `Leaving about ${timeOn(made.depart_at, now)}, getting to ${to} about ${eta}. Live ETA:`;
  return `On my way to ${to}, arriving about ${eta} via ${made.main_road}. Live ETA:`;
}

export type SendResult = "shared" | "copied" | "cancelled" | "manual";

/** Phones: the system share sheet. Computers (or when the sheet isn't there or refuses): copy the link.
 * "manual" = neither worked (e.g. not https, or the tap was too long ago): show the link to copy by hand. */
export async function sendLink(url: string, text: string, sheet: boolean): Promise<SendResult> {
  if (sheet && typeof navigator.share === "function") {
    try {
      await navigator.share({ title: "My ETA", text, url });
      return "shared";
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return "cancelled";
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return "copied";
  } catch {
    return "manual";
  }
}

/** Touch screens get the share sheet; mouse-and-keyboard computers get the clipboard. */
export function prefersShareSheet(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
}
