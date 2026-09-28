"use client";

/** The camera's "live video" card (design "Live cameras"): a procedural animated view with a LIVE
 * badge, the simulated clock, the camera name and pause / full-screen buttons. */

import { useEffect, useId, useMemo, useRef, useState } from "react";

import { Icon } from "@/components/ui";
import { C, ICON } from "@/lib/theme";
import type { LiveConditions } from "@/lib/types";

import { EXIT_FULL, useFullscreen } from "./fullscreen";
import { createScene, frame, showsTrain, step, VIEW_H, VIEW_W, type RailCar } from "./scene";

export type LiveCam = LiveConditions["cameras"][number];

/** The simulated clock: `sim` ms at real `real` ms, running at `speed` x real time. */
export interface SimBase {
  sim: number;
  real: number;
  speed: number;
}

const LIGHT_OFF = "#3A2A2C";

function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function RailCarShape({ c, ox }: { c: RailCar; ox: number }) {
  const x = c.x + ox;
  const w = c.w;
  let body;
  if (c.type === "tank") {
    body = (
      <>
        <rect x={x + 2} y={89} width={w - 4} height={18} rx={9} fill={c.color} />
        <rect x={x + w / 2 - 5} y={86} width={10} height={3.5} fill={c.color} />
        <path d={`M${x + 18} 90V106M${x + w - 18} 90V106`} stroke="rgba(0,0,0,0.25)" strokeWidth={1.2} />
        <rect x={x + 10} y={95} width={w * 0.24} height={2.5} fill="rgba(255,255,255,0.2)" />
      </>
    );
  } else if (c.type === "hopper") {
    let ribs = "";
    for (let rx = x + 10; rx < x + w - 6; rx += 11) ribs += `M${rx} 87V100`;
    body = (
      <>
        <path d={`M${x} 86H${x + w}V101L${x + w - 14} 108H${x + 14}L${x} 101Z`} fill={c.color} />
        <path d={ribs} stroke="rgba(0,0,0,0.25)" strokeWidth={1.2} />
        <rect x={x} y={86} width={w} height={2} fill="rgba(255,255,255,0.1)" />
      </>
    );
  } else {
    let ribs = "";
    for (let rx = x + 8; rx < x + w - 4; rx += 8) ribs += `M${rx} 86V108`;
    body = (
      <>
        <rect x={x} y={84} width={w} height={25} fill={c.color} />
        <rect x={x} y={84} width={w} height={2} fill="rgba(255,255,255,0.12)" />
        <path d={ribs} stroke="rgba(0,0,0,0.2)" strokeWidth={1} />
        <rect x={x + w * 0.4} y={88} width={w * 0.2} height={20} fill="rgba(0,0,0,0.2)" />
        <rect x={x + 7} y={89} width={w * 0.22} height={2.5} fill="rgba(255,255,255,0.22)" />
      </>
    );
  }
  return (
    <g>
      {body}
      <path d={`M${x} 109.5H${x + w}M${x + w} 106.5H${x + w + 6}`} stroke="#0E1015" strokeWidth={2} />
      <rect x={x + 5} y={109} width={20} height={3.5} fill="#15171C" />
      <rect x={x + w - 25} y={109} width={20} height={3.5} fill="#15171C" />
      {[x + 9, x + 21, x + w - 21, x + w - 9].map((cx) => (
        <circle key={cx} cx={cx} cy={114.2} r={2.6} fill="#1A1C21" stroke="#4A4F5A" strokeWidth={0.6} />
      ))}
    </g>
  );
}

/** Rails across the whole picture, with a crossing panel where they cross the road. */
function Tracks() {
  let ties = "";
  for (let x = 1; x < VIEW_W; x += 6) ties += `M${x} 110.5V119.5`;
  return (
    <g>
      <rect x={0} y={109} width={VIEW_W} height={12} fill="#1B1D22" />
      <path d={ties} stroke="#2E2A27" strokeWidth={2.2} />
      <path d="M111 109L239 109L256 121L94 121Z" fill="#33363D" />
      <path d={`M0 112.5H${VIEW_W}M0 117H${VIEW_W}`} stroke="#7C828E" strokeWidth={1.3} />
      {/* stop bars */}
      <path d="M178 134H270M130 97H172" stroke="#C9CDD4" strokeWidth={1.4} opacity={0.55} />
    </g>
  );
}

export default function CameraFeed({
  cam,
  name,
  base,
}: {
  cam: LiveCam;
  /** Display name */
  name: string;
  base: SimBase | null;
}) {
  const [paused, setPaused] = useState(false);
  const [frozenAt, setFrozenAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [imgFailed, setImgFailed] = useState(false);
  // Letterboxed (full screen), an SVG shows what lies outside its viewBox: clip to the frame.
  const clip = `camclip${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const cardRef = useRef<HTMLDivElement>(null);
  const { full, pseudoFull, toggle: toggleFull } = useFullscreen(cardRef);
  const bodiesRef = useRef<SVGPathElement>(null);
  const headsRef = useRef<SVGPathElement>(null);
  const tailsRef = useRef<SVGPathElement>(null);
  const rainRef = useRef<SVGPathElement>(null);
  const trainRef = useRef<SVGGElement>(null);
  const lightRefs = useRef<(SVGCircleElement | null)[]>([]);

  const train = showsTrain(cam);
  // Rebuild the picture only when what it shows changes (not on every data refresh).
  const scene = useMemo(
    () =>
      createScene({
        id: cam.id,
        kind: cam.kind,
        level: cam.level,
        weather: cam.weather,
        blocked: train,
      }),
    [cam.id, cam.kind, cam.level, cam.weather, train],
  );
  const first = useMemo(() => frame(scene), [scene]);
  const blocked = !!scene.train;

  // Animation: write straight to the SVG (no React re-render per frame).
  useEffect(() => {
    const paint = () => {
      const f = frame(scene);
      bodiesRef.current?.setAttribute("d", f.bodies);
      headsRef.current?.setAttribute("d", f.heads);
      tailsRef.current?.setAttribute("d", f.tails);
      rainRef.current?.setAttribute("d", f.rain);
      trainRef.current?.setAttribute("transform", `translate(${f.trainX} 0)`);
      lightRefs.current.forEach((el, i) => el?.setAttribute("fill", blocked && (i % 2 === 0) === f.blink ? C.heavy : LIGHT_OFF));
    };
    paint();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (paused || reduced) return;
    let raf = 0;
    let last = performance.now();
    const tick = (t: number) => {
      step(scene, Math.min(0.1, Math.max(0, (t - last) / 1000)));
      last = t;
      paint();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [scene, paused, blocked]);

  // The clock ticks while live.
  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [paused]);

  const liveMs = base ? base.sim + (now - base.real) * base.speed : null;
  const shownMs = paused ? frozenAt : liveMs;
  const togglePause = () => {
    // Freeze on the time that is showing; resume jumps back to live time.
    if (!paused) setFrozenAt(liveMs);
    else setNow(Date.now());
    setPaused(!paused);
  };
  const levelWord = cam.level === "heavy" ? "heavy" : cam.level === "moderate" ? "moderate" : "light";
  const snapshot = !cam.mock && cam.snapshot_url && !imgFailed ? cam.snapshot_url : null;
  const badge = "rgba(11,13,17,0.8)";

  return (
    <div
      ref={cardRef}
      className={`overflow-hidden ${pseudoFull ? "fixed inset-0 z-[3000]" : "relative"} ${
        full ? "flex items-center justify-center" : "rounded-2xl border border-line"
      }`}
      data-theme="dark"
      style={{ background: "#0B0D11" }}
    >
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        role="img"
        aria-label={`Live camera view of ${name}, ${levelWord} traffic${blocked ? ", a train is crossing" : ""}`}
        className={full ? "block h-full w-full" : "block h-auto w-full"}
        style={full ? undefined : { aspectRatio: `${VIEW_W} / ${VIEW_H}` }}
      >
        <defs>
          <clipPath id={clip}>
            <rect x={0} y={0} width={VIEW_W} height={VIEW_H} />
          </clipPath>
        </defs>
        <g clipPath={`url(#${clip})`}>
          <rect x={0} y={0} width={VIEW_W} height={72} fill="#10131A" />
          <path d={scene.skyline} fill="#181C24" />
          <path d={scene.windows} fill="#C9A447" opacity={0.7} />
          <rect x={0} y={72} width={VIEW_W} height={148} fill="#15181E" />
          <path d="M165 72 L 185 72 L 400 220 L -50 220 Z" fill="#2A2E36" />
          <path d="M173 72 L 150 220 M 177 72 L 200 220" stroke="#C9A12E" strokeWidth={1.5} />
          <path d="M175 72 L 20 220 M 175 72 L 80 220 M 175 72 L 270 220 M 175 72 L 330 220" stroke="#8A8F99" strokeWidth={1.2} strokeDasharray="8 10" />
          <path d="M60 72 V 150 M 290 72 V 150" stroke="#3A3F4A" strokeWidth={2} />

          {scene.crossing && (
            <>
              <Tracks />
              {/* far-side gate (left) */}
              <g>
                <path d="M112 105V81" stroke="#8A8F99" strokeWidth={1.5} />
                <path d="M108 79L116 85M108 85L116 79" stroke="#E6E8EC" strokeWidth={1.6} />
                <path d="M107.5 89H116.5" stroke="#1B1D22" strokeWidth={1} />
                <circle ref={(el) => void (lightRefs.current[2] = el)} cx={109} cy={89} r={1.8} fill={LIGHT_OFF} />
                <circle ref={(el) => void (lightRefs.current[3] = el)} cx={115} cy={89} r={1.8} fill={LIGHT_OFF} />
                <path d={blocked ? "M116 99H172" : "M116 99L121 52"} stroke="#ECEDEF" strokeWidth={1.8} />
                <path d={blocked ? "M116 99H172" : "M116 99L121 52"} stroke={C.heavy} strokeWidth={1.8} strokeDasharray="4 4" />
              </g>
            </>
          )}

          <path ref={bodiesRef} d={first.bodies} fill="#4B515E" />
          <path ref={headsRef} d={first.heads} fill="#FFF3C4" />
          <path ref={tailsRef} d={first.tails} fill="#FF4D4D" />

          {scene.train && (
            <g ref={trainRef} transform={`translate(${first.trainX} 0)`}>
              {[0, scene.train.length].map((ox) => (
                <g key={ox}>
                  {scene.train!.cars.map((c) => (
                    <RailCarShape key={c.x} c={c} ox={ox} />
                  ))}
                </g>
              ))}
            </g>
          )}

          {scene.crossing && (
            /* near-side gate (right) */
            <g>
              <path d="M272 129V92" stroke="#9AA0AE" strokeWidth={2} />
              <path d="M266 89L278 98M266 98L278 89" stroke="#E6E8EC" strokeWidth={2.2} />
              <path d="M265 104H279" stroke="#1B1D22" strokeWidth={1.4} />
              <circle ref={(el) => void (lightRefs.current[0] = el)} cx={268} cy={104} r={2.6} fill={LIGHT_OFF} />
              <circle ref={(el) => void (lightRefs.current[1] = el)} cx={276} cy={104} r={2.6} fill={LIGHT_OFF} />
              <rect x={265} y={115.5} width={8} height={5} fill="#2A2E36" />
              <path d={blocked ? "M266 118.5H178" : "M266 118.5L258 52"} stroke="#ECEDEF" strokeWidth={2.6} />
              <path d={blocked ? "M266 118.5H178" : "M266 118.5L258 52"} stroke={C.heavy} strokeWidth={2.6} strokeDasharray="6 6" />
            </g>
          )}

          <path ref={rainRef} d={first.rain} stroke="#9FB4CC" strokeWidth={1} opacity={0.45} />
        </g>
      </svg>

      {snapshot && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={snapshot} alt="" className="absolute inset-0 h-full w-full object-cover" onError={() => setImgFailed(true)} />
      )}

      <div className="absolute top-2.5 left-2.5 flex items-center gap-1.5 rounded-md px-2 py-1" style={{ background: badge }}>
        <span className="h-2 w-2 rounded-full" style={{ background: paused ? C.muted : C.heavy }} />
        <span className="text-[11px] font-bold tracking-[0.08em]">{paused ? "PAUSED" : "LIVE"}</span>
      </div>
      {shownMs !== null && (
        <span className="font-num absolute top-2.5 right-2.5 rounded-md px-2 py-1 text-[11px] text-soft" style={{ background: badge }}>
          {fmtClock(shownMs)}
        </span>
      )}

      <div className="absolute right-0 bottom-0 left-0 box-border flex h-[52px] items-center gap-1 pr-1.5 pl-3" style={{ background: "rgba(11,13,17,0.85)" }}>
        <div className="flex min-w-0 flex-grow flex-col gap-px">
          <span className="truncate text-[14px] font-semibold">{name}</span>
          <span className="text-[12px] text-muted">{cam.looking ?? "Live view"}</span>
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
  );
}
