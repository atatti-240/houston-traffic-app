import type { LiveFeed } from "@/lib/types";

/** Backend sends naive ISO datetimes in simulated Houston time; treat them as wall-clock. */
export function parseSim(iso: string): Date {
  const [d, t = "00:00:00"] = iso.split("T");
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi, s] = t.split(":").map((x) => parseFloat(x));
  return new Date(y, mo - 1, da, h, mi, Math.floor(s || 0));
}

export function toSimIso(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(
    date.getMinutes(),
  )}:00`;
}

/** `iso` moved by `minutes`, in the same format (keeps the seconds). */
export function addMinutesSim(iso: string, minutes: number): string {
  const d = new Date(parseSim(iso).getTime() + minutes * 60000);
  return `${toSimIso(d).slice(0, 17)}${String(d.getSeconds()).padStart(2, "0")}`;
}

export function fmtTime(iso: string): string {
  return parseSim(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function fmtDayTime(iso: string): string {
  const d = parseSim(iso);
  return `${d.toLocaleDateString([], { weekday: "short" })} ${fmtTime(iso)}`;
}

export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** 0 -> green, 0.5 -> amber, 1 -> red */
export function scoreColor(x: number): string {
  const v = Math.max(0, Math.min(1, x));
  const stops: [number, [number, number, number]][] = [
    [0, [34, 197, 94]],
    [0.35, [234, 179, 8]],
    [0.6, [249, 115, 22]],
    [1, [220, 38, 38]],
  ];
  for (let i = 1; i < stops.length; i++) {
    const [p1, c1] = stops[i];
    const [p0, c0] = stops[i - 1];
    if (v <= p1) {
      const t = (v - p0) / (p1 - p0);
      const c = c0.map((ch, k) => Math.round(ch + (c1[k] - ch) * t));
      return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
    }
  }
  return "rgb(220, 38, 38)";
}

/** Camera name for display: "Houston Ave @ UP crossing" -> "Houston Ave at UP crossing"; drops a repeated road name
 * ("I-45 Gulf Fwy @ I-45 Gulf Fwy @ Telephone Rd" -> "I-45 Gulf Fwy at Telephone Rd"). */
export function camName(raw: string): string {
  const parts = raw
    .replace(/\s+crossing cam$/i, " crossing")
    .replace(/\s+cam$/i, "")
    .split(/\s+@\s+/);
  const out: string[] = [];
  for (const p of parts) {
    if (out.length && out[0].startsWith(p)) continue;
    out.push(p);
  }
  return out.join(" at ");
}

/** A camera's live AI feed has video (or will once the camera AI starts it): not offline or missing. */
export function hasLiveVideo(feed: LiveFeed | null | undefined): boolean {
  return !!feed && feed.status !== "offline" && feed.status !== "missing";
}
