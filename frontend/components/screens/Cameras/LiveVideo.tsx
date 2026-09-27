"use client";

/** A camera's live AI video (design "Live cameras", with real video): the camera AI's MJPEG stream
 * in a plain <img>, its vehicle boxes drawn on top, a LIVE badge, and boxes / pause / full-screen
 * buttons. The video comes from a Baton Rouge camera standing in for this one; the bar says so. */

import { useCallback, useEffect, useRef, useState } from "react";

import { Icon } from "@/components/ui";
import { apiUrl } from "@/lib/api";
import { C, ICON, VEHICLE } from "@/lib/theme";
import type { LiveFeed } from "@/lib/types";

import type { LiveCam } from "./CameraFeed";
import { EXIT_FULL, useFullscreen } from "./fullscreen";
import type { BoxTrack, DrawnBox } from "./liveFeed";

const VIEW_W = 1600;
const VIEW_H = 900;
const BOXES_KEY = "blindspot.camBoxes";
/** Start a new stream before the server ends a long one (after 30 min). */
const RESTART_MS = 25 * 60 * 1000;

/** Vehicle boxes for the moment of the video on screen (or a frozen moment while paused). */
function BoxOverlay({
  track,
  offset,
  delay,
  at,
}: {
  track: BoxTrack;
  offset: { current: number | null };
  delay: number;
  at: number | null;
}) {
  const [boxes, setBoxes] = useState<DrawnBox[]>([]);
  useEffect(() => {
    if (at !== null) {
      setBoxes(track.at(at));
      return;
    }
    let raf = 0;
    let last = 0;
    const loop = (ts: number) => {
      if (ts - last >= 40) {
        last = ts;
        // The frame on screen was taken `delay` ms ago on the server's clock.
        setBoxes(offset.current === null ? [] : track.at(Date.now() + offset.current - delay));
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [track, offset, delay, at]);
  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
    >
      {boxes.map((b, i) => (
        <g key={i} opacity={b.opacity}>
          <rect
            x={b.x * VIEW_W}
            y={b.y * VIEW_H}
            width={b.w * VIEW_W}
            height={b.h * VIEW_H}
            fill="none"
            stroke="rgba(11,13,17,0.6)"
            strokeWidth={3.5}
            vectorEffect="non-scaling-stroke"
          />
          <rect
            x={b.x * VIEW_W}
            y={b.y * VIEW_H}
            width={b.w * VIEW_W}
            height={b.h * VIEW_H}
            fill="none"
            stroke={VEHICLE[b.cls]?.color ?? C.soft}
            strokeWidth={1.6}
            vectorEffect="non-scaling-stroke"
          />
        </g>
      ))}
    </svg>
  );
}

/** The MJPEG stream's <img>: sets its src itself, and drops it when the <img> goes away so the
 * browser stops downloading the stream (a removed <img> can keep it open). */
function Stream({ url, alt, onError }: { url: string; alt: string; onError: () => void }) {
  const ref = useCallback(
    (el: HTMLImageElement | null) => {
      if (!el) return;
      el.src = url;
      return () => el.removeAttribute("src");
    },
    [url],
  );
  // eslint-disable-next-line @next/next/no-img-element
  return <img ref={ref} alt={alt} className="absolute inset-0 h-full w-full object-fill" onError={onError} />;
}

export default function LiveVideo({
  cam,
  name,
  feed,
  track,
  offset,
  delayMs,
}: {
  cam: LiveCam;
  /** Display name */
  name: string;
  feed: LiveFeed;
  track: BoxTrack;
  offset: { current: number | null };
  delayMs: number;
}) {
  const [paused, setPaused] = useState(false);
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const [boxesOn, setBoxesOn] = useState(true);
  const [nonce, setNonce] = useState(0);
  const [failed, setFailed] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const { full, pseudoFull, toggle: toggleFull } = useFullscreen(cardRef);
  const live = feed.status === "live";

  useEffect(() => {
    try {
      if (localStorage.getItem(BOXES_KEY) === "off") setBoxesOn(false);
    } catch {}
  }, []);

  // A fresh stream when the feed comes back live, a few seconds after an error, and every 25 min.
  const wasLive = useRef(live);
  useEffect(() => {
    if (live && !wasLive.current) setNonce((n) => n + 1);
    wasLive.current = live;
  }, [live]);
  useEffect(() => {
    if (!failed) return;
    const id = setTimeout(() => {
      setFailed(false);
      setNonce((n) => n + 1);
    }, 3000);
    return () => clearTimeout(id);
  }, [failed]);
  useEffect(() => {
    if (!live || paused) return;
    const id = setInterval(() => setNonce((n) => n + 1), RESTART_MS);
    return () => clearInterval(id);
  }, [live, paused]);

  const togglePause = () => {
    // Freeze on the frame that's showing (and its boxes); resume goes back to live.
    if (!paused) setPausedAt(offset.current === null ? Date.now() : Date.now() + offset.current - delayMs);
    setPaused(!paused);
  };
  const toggleBoxes = () => {
    const next = !boxesOn;
    setBoxesOn(next);
    try {
      localStorage.setItem(BOXES_KEY, next ? "on" : "off");
    } catch {}
  };

  const streaming = live && !paused && !failed;
  const still = paused && pausedAt !== null;
  const badge = paused ? "PAUSED" : !live ? "STARTING" : feed.replay ? "REPLAY" : "LIVE";
  const message = paused
    ? null
    : !live
      ? feed.status === "paused"
        ? "The camera AI is busy with another camera right now (it runs one at a time)."
        : "Starting the live video…"
      : failed
        ? "Reconnecting to the live video…"
        : null;
  const bar = "rgba(11,13,17,0.85)";

  return (
    <div
      ref={cardRef}
      className={`overflow-hidden ${pseudoFull ? "fixed inset-0 z-[3000]" : "relative"} ${
        full ? "flex items-center justify-center" : "rounded-2xl border border-line"
      }`}
      style={{ background: "#0B0D11" }}
    >
      <div className="relative aspect-video" style={{ width: full ? "min(100vw, calc(100vh * 16 / 9))" : "100%" }}>
        {streaming && (
          <Stream
            key={nonce}
            url={`${apiUrl(feed.video_url)}?n=${nonce}`}
            alt={`Live video from the camera AI for ${name}`}
            onError={() => setFailed(true)}
          />
        )}
        {still && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`${apiUrl(feed.frame_url)}?at=${Math.round(pausedAt as number)}`}
            alt={`Paused video from the camera AI for ${name}`}
            className="absolute inset-0 h-full w-full object-fill"
          />
        )}
        {message && (
          <div role="status" className="absolute inset-0 flex items-center justify-center px-8 text-center text-[13px] text-muted">
            {message}
          </div>
        )}
        {boxesOn && (streaming || still) && <BoxOverlay track={track} offset={offset} delay={delayMs} at={still ? pausedAt : null} />}
      </div>

      <div className="absolute top-2.5 right-2.5 flex items-center gap-1.5 rounded-md px-2 py-1" style={{ background: "rgba(11,13,17,0.8)" }}>
        <span className="h-2 w-2 rounded-full" style={{ background: badge === "LIVE" || badge === "REPLAY" ? C.heavy : C.muted }} />
        <span className="text-[11px] font-bold tracking-[0.08em]">{badge}</span>
      </div>

      {/* Under the picture (it's real video: nothing of it hidden), over it in full screen */}
      <div
        className={`${full ? "absolute right-0 bottom-0 left-0" : "relative"} box-border flex h-[52px] items-center gap-0.5 pr-1.5 pl-3`}
        style={{ background: bar }}
      >
        <div className="flex min-w-0 flex-grow flex-col gap-px">
          <span className="truncate text-[14px] font-semibold">{name}</span>
          <span className="truncate text-[12px] text-muted">
            Baton Rouge stand-in · {cam.looking ?? "Live view"}
          </span>
        </div>
        <button
          type="button"
          onClick={toggleBoxes}
          aria-pressed={boxesOn}
          aria-label={boxesOn ? "Hide vehicle boxes" : "Show vehicle boxes"}
          title={boxesOn ? "Hide vehicle boxes" : "Show vehicle boxes"}
          className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full hover:bg-white/10"
        >
          <Icon d={ICON.boxes} size={20} width={2} color={boxesOn ? C.accent : C.muted} />
        </button>
        <button
          type="button"
          onClick={togglePause}
          aria-label={paused ? "Resume live video" : "Pause live video"}
          className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full hover:bg-white/10"
        >
          <Icon d={paused ? ICON.play : ICON.pause} size={20} width={2.2} color={C.ink} />
        </button>
        <button
          type="button"
          onClick={toggleFull}
          aria-label={full ? "Exit full screen" : "Full screen"}
          className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full hover:bg-white/10"
        >
          <Icon d={full ? EXIT_FULL : ICON.expand} size={20} width={2.2} color={C.ink} />
        </button>
      </div>
    </div>
  );
}
