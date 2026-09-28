"use client";

/** Real live video for a camera without the camera AI's video: a Baton Rouge traffic camera
 * (Louisiana DOTD 511LA) standing in for the Houston one, always the same one for the same camera
 * and labeled as a stand-in on the picture and under it. hls.js is loaded on first use (Safari and
 * iOS play the stream themselves). A camera that doesn't play within 12 s hands over to the next
 * one; after a few, or when the stream host can't be reached at all, the simulated view shows,
 * labeled as simulated. One stream at a time, stopped while the tab is hidden. */

import type Hls from "hls.js";
import type { ErrorData } from "hls.js";
import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/ui";
import { C, ICON } from "@/lib/theme";
import type { LiveFeed } from "@/lib/types";

import CameraFeed, { type LiveCam, type SimBase } from "./CameraFeed";
import { EXIT_FULL, useFullscreen } from "./fullscreen";
import { laCamFor, LA_SITE, laStreamUrl } from "./laCams";
import { FeedOffline } from "./LiveFeedPanel";

/** A camera that hasn't started playing by then is skipped. */
const CONNECT_MS = 12_000;
/** Cameras tried in a row before the simulated view. */
const TRIES = 3;
/** When the stream host didn't answer at all, or camera after camera failed, the next camera would
 * most likely fail the same way: skip live video for a while (on every camera), unless asked to try
 * again. */
const HOST_DOWN_MS = 2 * 60_000;
let hostDownUntil = 0;

const HLS_CONFIG = {
  liveSyncDurationCount: 2,
  liveMaxLatencyDurationCount: 5,
  manifestLoadingMaxRetry: 1,
  levelLoadingMaxRetry: 1,
  fragLoadingMaxRetry: 2,
  backBufferLength: 30,
};

/** The picture's shape: the simulated view's, so nothing jumps when one replaces the other. */
const RATIO_W = 350;
const RATIO_H = 220;
const badgeBg = "rgba(11,13,17,0.8)";

/** Safari and iOS have their own HLS player (and iPhones have no MediaSource for hls.js). */
function nativeHls(video: HTMLVideoElement): boolean {
  if (!video.canPlayType("application/vnd.apple.mpegurl")) return false;
  return typeof MediaSource === "undefined" || navigator.vendor.startsWith("Apple");
}

export default function HlsVideo({
  cam,
  name,
  base,
  feed,
}: {
  cam: LiveCam;
  /** Display name */
  name: string;
  base: SimBase | null;
  /** The camera AI's feed for this camera, if it has one (offline or missing here) */
  feed: LiveFeed | null;
}) {
  /** Steps through the Baton Rouge cameras from this camera's own one when one won't play. */
  const [attempt, setAttempt] = useState(0);
  /** Bumped to open the stream afresh (resume, back to the tab, try again). */
  const [run, setRun] = useState(0);
  const [sim, setSim] = useState(false);
  /** Which stream (attempt:run) is playing. Anything else is still connecting. */
  const [playing, setPlaying] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [hidden, setHidden] = useState(false);
  const pausedRef = useRef(false);
  const failsRef = useRef(0);
  const stopRef = useRef<(() => void) | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const { full, pseudoFull, toggle: toggleFull } = useFullscreen(cardRef);

  const la = laCamFor(cam.id, attempt);
  const key = `${attempt}:${run}`;
  // A hidden tab holds no stream (a paused one has stopped loading already and keeps its frame).
  const suspended = hidden && !paused;

  useEffect(() => {
    const video = videoRef.current;
    if (sim || suspended || !video) return;
    if (!navigator.onLine || Date.now() < hostDownUntil) {
      setSim(true);
      return;
    }
    const src = laStreamUrl(laCamFor(cam.id, attempt));
    const stream = `${attempt}:${run}`;
    let hls: Hls | null = null;
    let done = false;
    const timer = setTimeout(() => fail(false), CONNECT_MS);

    const teardown = () => {
      clearTimeout(timer);
      hls?.destroy();
      hls = null;
      video.pause();
      video.removeAttribute("src");
      try {
        video.load();
      } catch {}
    };
    /** `host`: the stream host didn't answer at all, so no other camera will play either. */
    const fail = (host: boolean) => {
      if (done) return;
      done = true;
      teardown();
      failsRef.current += 1;
      if (host || failsRef.current >= TRIES) {
        hostDownUntil = Date.now() + HOST_DOWN_MS;
        setSim(true);
      } else setAttempt((a) => a + 1);
    };
    const kick = () => {
      if (!pausedRef.current) video.play().catch(() => {});
    };
    const started = () => {
      clearTimeout(timer);
      failsRef.current = 0;
      setPlaying(stream);
    };
    const onCanPlay = () => {
      started();
      kick();
    };
    const onError = () => {
      if (!hls) fail(false);
    };
    video.addEventListener("playing", started);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("error", onError);
    video.muted = true;
    stopRef.current = () => {
      clearTimeout(timer);
      hls?.stopLoad();
      video.pause();
    };

    if (nativeHls(video)) {
      video.src = src;
      kick();
    } else {
      import("hls.js")
        .then(({ default: HlsJs }) => {
          if (done) return;
          if (!HlsJs.isSupported()) {
            done = true;
            teardown();
            setSim(true);
            return;
          }
          const h = new HlsJs(HLS_CONFIG);
          hls = h;
          h.on(HlsJs.Events.ERROR, (_e, d: ErrorData) => {
            if (!d.fatal) return;
            const noAnswer = d.details === HlsJs.ErrorDetails.MANIFEST_LOAD_ERROR && !d.response?.code;
            fail(noAnswer);
          });
          h.on(HlsJs.Events.MANIFEST_PARSED, kick);
          h.loadSource(src);
          h.attachMedia(video);
        })
        // The player itself didn't load (offline): no retries.
        .catch(() => fail(true));
    }

    return () => {
      done = true;
      stopRef.current = null;
      video.removeEventListener("playing", started);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("error", onError);
      teardown();
    };
  }, [cam.id, attempt, run, sim, suspended]);

  // Hidden tab: drop the stream; back: open it afresh (at the live edge).
  useEffect(() => {
    const on = () => {
      setHidden(document.hidden);
      if (!document.hidden && !pausedRef.current) setRun((r) => r + 1);
    };
    setHidden(document.hidden);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);

  const retry = () => {
    hostDownUntil = 0;
    failsRef.current = 0;
    pausedRef.current = false;
    setPaused(false);
    setAttempt(0);
    setSim(false);
    setRun((r) => r + 1);
  };

  // Offline: the simulated view right away, quietly; back online: live video again.
  useEffect(() => {
    const off = () => setSim(true);
    const on = () => {
      if (!sim) return;
      hostDownUntil = 0;
      failsRef.current = 0;
      setAttempt(0);
      setSim(false);
      setRun((r) => r + 1);
    };
    window.addEventListener("offline", off);
    window.addEventListener("online", on);
    return () => {
      window.removeEventListener("offline", off);
      window.removeEventListener("online", on);
    };
  }, [sim]);

  if (sim) {
    return (
      <>
        <CameraFeed cam={cam} name={name} base={base} simulated />
        <p className="m-0 text-[12px] leading-snug text-muted">
          The Baton Rouge stand-in video couldn&apos;t load here.{" "}
          <button type="button" onClick={retry} className="cursor-pointer rounded font-semibold hover:underline" style={{ color: C.accent }}>
            Try live video again
          </button>
        </p>
        <FeedOffline feed={feed} />
      </>
    );
  }

  const togglePause = () => {
    if (!paused) {
      pausedRef.current = true;
      stopRef.current?.();
      setPaused(true);
    } else {
      // Back to live, not to where it stopped.
      pausedRef.current = false;
      failsRef.current = 0;
      setPaused(false);
      setRun((r) => r + 1);
    }
  };

  const live = playing === key;
  const badge = paused ? "PAUSED" : live ? "LIVE" : "CONNECTING";

  return (
    <>
      <div
        ref={cardRef}
        className={`overflow-hidden ${pseudoFull ? "fixed inset-0 z-[3000]" : "relative"} ${
          full ? "flex items-center justify-center" : "rounded-2xl border border-line"
        }`}
        data-theme="dark"
        style={{ background: "#0B0D11" }}
      >
        <div className="relative" style={{ aspectRatio: `${RATIO_W} / ${RATIO_H}`, width: full ? `min(100vw, calc(100vh * ${RATIO_W} / ${RATIO_H}))` : "100%" }}>
          <video
            ref={videoRef}
            muted
            playsInline
            autoPlay
            disablePictureInPicture
            aria-label={`Live video from a Baton Rouge traffic camera, ${la.name}, standing in for ${name}`}
            className="absolute inset-0 h-full w-full object-contain"
          />
          {!live && !paused && (
            <div role="status" className="absolute inset-0 flex items-center justify-center px-8 text-center text-[13px] text-muted">
              {attempt > 0 ? "That camera didn't load. Trying another Baton Rouge camera…" : `Connecting to Baton Rouge camera: ${la.name}…`}
            </div>
          )}
        </div>

        <div className="absolute top-2.5 left-2.5 flex items-center gap-1.5 rounded-md px-2 py-1" style={{ background: badgeBg }}>
          <span className="h-2 w-2 rounded-full" style={{ background: badge === "LIVE" ? C.heavy : C.muted }} />
          <span className="text-[11px] font-bold tracking-[0.08em]">{badge}</span>
        </div>

        {/* Under the picture (it's real video: nothing of it hidden), over it in full screen */}
        <div
          className={`${full ? "absolute right-0 bottom-0 left-0" : "relative"} box-border flex h-[52px] items-center gap-1 pr-1.5 pl-3`}
          style={{ background: "rgba(11,13,17,0.85)" }}
        >
          <div className="flex min-w-0 flex-grow flex-col gap-px">
            <span className="truncate text-[14px] font-semibold">Baton Rouge · {la.name}</span>
            <span className="truncate text-[12px] text-muted">Stand-in · Louisiana DOTD 511LA</span>
          </div>
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

      <p className="m-0 text-[12px] leading-snug text-soft">
        Live video: Baton Rouge, {la.name} (Louisiana DOTD{" "}
        <a href={LA_SITE} target="_blank" rel="noopener noreferrer" className="font-semibold hover:underline" style={{ color: C.accent }}>
          511LA
        </a>
        ), standing in for this Houston camera. It isn&apos;t this road: the traffic level below comes from Houston traffic data.
      </p>
      <FeedOffline feed={feed} standIn={la} />
    </>
  );
}
