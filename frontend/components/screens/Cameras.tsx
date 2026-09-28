"use client";

/** Live cameras (design "Live cameras"): pick an area, watch a camera's live view and see what it
 * shows; the note links to "Why it's slow" for that road. The map marks the selected camera.
 * Cameras with a live AI feed (the team's camera AI on a Baton Rouge camera standing in for ours)
 * come first and show the real video with vehicle boxes; the rest show live video from a Baton Rouge
 * camera standing in (labeled so), or a simulated view when that won't load. */

import { useEffect, useMemo, useRef, useState } from "react";

import { useApp, type MapScene, type Screen } from "@/components/app/AppContext";
import type { LiveCam, SimBase } from "@/components/screens/Cameras/CameraFeed";
import HlsVideo from "@/components/screens/Cameras/HlsVideo";
import LiveFeedPanel from "@/components/screens/Cameras/LiveFeedPanel";
import LiveVideo from "@/components/screens/Cameras/LiveVideo";
import { useLiveFeed } from "@/components/screens/Cameras/liveFeed";
import { BackHeader, Card, FilterChip, Icon, LevelDot, LevelPill } from "@/components/ui";
import { camName, hasLiveVideo, parseSim } from "@/lib/format";
import { C, ICON, LEVEL, tint, type Level } from "@/lib/theme";

const RANK: Record<Level, number> = { heavy: 2, moderate: 1, light: 0 };

/** Has live video from the camera AI (or will once it's connected). */
const hasFeed = (c: LiveCam) => hasLiveVideo(c.live_feed);

type Pick = { area?: string; cam?: string };
/** What each cameras screen (stack entry) was showing, so "Back" from "Why it's slow" returns to
 * the same camera. Keyed by the stack entry itself: opening the screen afresh starts fresh. */
const memory = new WeakMap<Screen, Pick>();

/** Live AI feeds first, then worst first: level, then delay, then name. */
function worstFirst(a: LiveCam, b: LiveCam): number {
  return (
    Number(hasFeed(b)) - Number(hasFeed(a)) ||
    RANK[b.level] - RANK[a.level] ||
    b.delay_min - a.delay_min ||
    a.name.localeCompare(b.name)
  );
}

/** "Galleria / Uptown" -> "Galleria", "Texas Medical Center" -> "Medical Center" */
function shortArea(area: string): string {
  return area.replace(/\s*\/.*$/, "").replace(/^Texas\s+/, "");
}

/** Drop a zero delay ("· +0 min") and keep "+11 min" on one line. */
function tidyNote(note: string): string {
  return note.replace(/\s*·\s*\+0 min$/, "").replace(/\+(\d+) min/, "+$1 min");
}

interface Area {
  name: string;
  label: string;
  cams: LiveCam[];
  slow: number;
  /** Cameras with live AI video */
  feeds: number;
}

function Header({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex items-center gap-1">
      <BackHeader onBack={onBack} />
      <h1 className="m-0 text-[24px] font-bold tracking-[-0.02em]">Live cameras</h1>
    </div>
  );
}

function CamRow({ cam, selected, onPick }: { cam: LiveCam; selected: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={selected}
      className={`flex w-full cursor-pointer items-center gap-3 rounded-[14px] py-2.5 pr-3.5 pl-2.5 text-left ${selected ? "" : "bg-card hover:bg-card-hi"}`}
      style={{
        background: selected ? C.cardHi : undefined,
        border: `1.5px solid ${selected ? C.accent : "transparent"}`,
      }}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-line">
        <Icon d={ICON.video} size={18} color={C.ink} />
      </span>
      <span className="flex min-w-0 flex-grow flex-col gap-0.5">
        <span className="text-[14px] font-semibold text-ink">{camName(cam.name)}</span>
        <span className="text-[12px] text-muted">
          {cam.looking ?? "Live view"} · {LEVEL[cam.level].label} traffic
        </span>
      </span>
      {hasFeed(cam) && (
        <span
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold tracking-[0.08em] whitespace-nowrap"
          style={{ background: tint(C.heavy, 12), color: C.heavyText }}
          title="Real video with the camera AI's vehicle boxes"
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: C.heavy }} />
          LIVE AI
        </span>
      )}
      <LevelDot level={cam.level} size={10} />
    </button>
  );
}

/** The note with a chevron that stays on the line of its last word. */
function NoteText({ note }: { note: string }) {
  const i = note.lastIndexOf(" ");
  return (
    <>
      {i > 0 ? note.slice(0, i + 1) : ""}
      <span className="whitespace-nowrap">
        {i > 0 ? note.slice(i + 1) : note}
        <Icon d={ICON.chevron} size={14} color={C.muted} className="ml-0.5 inline-block align-[-3px]" />
      </span>
    </>
  );
}

function Loading({ failed }: { failed: boolean }) {
  return (
    <>
      <div className="flex gap-2" aria-hidden="true">
        {[92, 84, 96].map((w) => (
          <span key={w} className="h-9 shrink-0 rounded-[18px] border border-edge-strong" style={{ width: w }} />
        ))}
      </div>
      <div
        role="status"
        className="flex w-full items-center justify-center rounded-2xl border border-line px-6 text-center text-[13px] text-muted"
        data-theme="dark"
        style={{ aspectRatio: "350 / 220", background: "#0B0D11" }}
      >
        {failed ? "Can't reach the cameras right now. We'll keep trying." : "Connecting to cameras…"}
      </div>
    </>
  );
}

export default function Cameras() {
  const { screen, back, go, live, clock, backendDown, setScene, scene } = useApp();
  const params = screen.name === "cameras" ? screen : { area: undefined, camId: undefined };
  const [pick, setPick] = useState<Pick>(() => memory.get(screen) ?? { area: params.area, cam: params.camId });
  // A new entry with the same area and camera (the same map marker again, or Back to an earlier one)
  // doesn't remount this screen: show what that entry asks for, or what it showed last.
  const [entry, setEntry] = useState(screen);
  if (entry !== screen) {
    setEntry(screen);
    setPick(memory.get(screen) ?? { area: params.area, cam: params.camId });
  }
  useEffect(() => {
    memory.set(screen, pick);
  }, [screen, pick]);

  const cams = useMemo(() => live?.cameras ?? [], [live]);

  // Areas with live AI video first, then most slow cameras (then by name); each area's cameras
  // live video first, then worst first.
  const areas = useMemo<Area[]>(() => {
    const byArea = new Map<string, LiveCam[]>();
    for (const c of cams) {
      const list = byArea.get(c.area) ?? [];
      list.push(c);
      byArea.set(c.area, list);
    }
    return [...byArea]
      .map(([name, list]) => ({
        name,
        label: shortArea(name),
        cams: [...list].sort(worstFirst),
        slow: list.filter((c) => c.level !== "light").length,
        feeds: list.filter(hasFeed).length,
      }))
      .sort((a, b) => b.feeds - a.feeds || b.slow - a.slow || a.name.localeCompare(b.name));
  }, [cams]);

  const picked = pick.cam ? cams.find((c) => c.id === pick.cam) : undefined;
  // An area from a link may be the full name ("Galleria / Uptown") or the chip label ("Galleria").
  const want = (picked?.area ?? pick.area)?.toLowerCase();
  const area = (want ? areas.find((a) => a.name.toLowerCase() === want || a.label.toLowerCase() === want) : undefined) ?? areas[0];
  const cam = (picked && area?.cams.includes(picked) ? picked : undefined) ?? area?.cams[0];
  const name = cam ? camName(cam.name) : "";

  // A camera with a live AI feed: its video, boxes, counts and incident check (polled while shown).
  const feedState = useLiveFeed(cam?.live_feed ? cam.id : null);
  // Right after switching cameras it still holds the previous camera's answer: not this one's. Until
  // this camera's own answer comes (right away), its summary from /live can be minutes old (the camera
  // AI may have moved to another camera since), so it doesn't start the video.
  const detail = feedState.detail?.camera_id === cam?.id ? feedState.detail : null;
  const summary = cam?.live_feed;
  const feed = summary
    ? (detail ?? (summary.status === "live" ? { ...summary, status: "connecting" as const } : summary))
    : null;
  const videoOn = hasLiveVideo(feed);

  // Once a camera is showing, keep it: a data refresh that re-sorts the list updates its picture
  // but doesn't switch to another camera (or drop pause / full screen).
  const camId = cam?.id;
  const areaName = area?.name;
  useEffect(() => {
    if (camId && areaName && pick.cam !== camId) setPick({ area: areaName, cam: camId });
  }, [camId, areaName, pick.cam]);

  // The simulated clock, running on from the last time the backend reported it (real seconds
  // when the demo clock is frozen, so the "live" picture's clock still ticks).
  const simNow = clock?.now;
  const simSpeed = clock?.speed ?? 1;
  const [base, setBase] = useState<SimBase | null>(null);
  useEffect(() => {
    if (simNow)
      setBase({
        sim: parseSim(simNow).getTime(),
        real: Date.now(),
        speed: simSpeed > 0 ? simSpeed : 1,
      });
  }, [simNow, simSpeed]);

  // Mark the camera on the map (and put it back if the shell clears the scene on arrival).
  const ours = useRef<{ id: string; scene: MapScene } | null>(null);
  useEffect(() => {
    if (!cam) return;
    if (scene && ours.current?.scene === scene && ours.current.id === cam.id) return;
    const s: MapScene = {
      points: [{ lat: cam.lat, lng: cam.lng, kind: "stop", label: name }],
      fit: [[cam.lat, cam.lng]],
    };
    ours.current = { id: cam.id, scene: s };
    setScene(s);
  }, [cam, name, scene, setScene]);

  // Keep the selected area chip in view (it may be far down the row).
  const chipsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = chipsRef.current;
    const chip = row?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!row || !chip) return;
    const r = row.getBoundingClientRect();
    const b = chip.getBoundingClientRect();
    const pad = 20;
    if (b.left < r.left + pad) row.scrollLeft += b.left - r.left - pad;
    else if (b.right > r.right - pad) row.scrollLeft += b.right - r.right + pad;
  }, [areaName]);

  // Picking a camera far down the list: bring its picture back into view.
  const feedRef = useRef<HTMLDivElement>(null);
  const pickCam = (areaName: string, camId: string) => {
    setPick({ area: areaName, cam: camId });
    const el = feedRef.current;
    if (!el || el.getBoundingClientRect().top >= 0) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({
      block: "start",
      behavior: reduced ? "auto" : "smooth",
    });
  };

  // The design uses the browser's normal line height throughout.
  const page = "flex flex-col gap-3.5 px-5 pt-[52px] pb-28 leading-[normal] md:pt-6 md:pb-8";

  if (!live) {
    return (
      <div className={page}>
        <Header onBack={back} />
        <Loading failed={backendDown} />
      </div>
    );
  }

  if (!cam || !area) {
    return (
      <div className={page}>
        <Header onBack={back} />
        <Card>
          <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-line">
            <Icon d={ICON.video} size={18} color={C.ink} />
          </span>
          <h2 className="m-0 text-[16px] font-semibold">No cameras reporting</h2>
          <p className="m-0 text-[13px] text-soft">None of Houston&apos;s traffic cameras are sending a picture right now. Check back in a few minutes.</p>
        </Card>
      </div>
    );
  }

  const count = area.cams.length;
  const note = tidyNote(cam.note);
  return (
    <div className={page}>
      <Header onBack={back} />

      {/* Clipped at the page padding as in the design; the 4px inset keeps focus rings visible. */}
      <div ref={chipsRef} role="group" aria-label="Choose an area" className="no-scrollbar -m-1 flex gap-2 overflow-x-auto p-1 pb-1.5">
        {areas.map((a) => (
          <FilterChip key={a.name} label={a.label} selected={a.name === area.name} onClick={() => setPick({ area: a.name, cam: a.cams[0].id })} />
        ))}
      </div>

      <div ref={feedRef} className="flex scroll-mt-3 flex-col gap-2">
        {videoOn && feed ? (
          <LiveVideo
            key={cam.id}
            cam={cam}
            name={name}
            feed={feed}
            track={feedState.track}
            offset={feedState.offset}
            delayMs={detail?.video_delay_ms ?? 2500}
          />
        ) : (
          <HlsVideo key={cam.id} cam={cam} name={name} base={base} feed={feed} />
        )}
      </div>

      <div className="flex items-center gap-2">
        <LevelPill level={cam.level} />
        {cam.slowdown_id ? (
          <button
            type="button"
            onClick={() => go({ name: "why", id: cam.slowdown_id as string })}
            aria-label={`${note}. ${cam.level === "light" ? "See this road's details" : "See why it's slow"}`}
            className="cursor-pointer rounded text-left text-[13px] text-soft hover:text-ink"
          >
            <NoteText note={note} />
          </button>
        ) : (
          <span className="text-[13px] text-soft">{note}</span>
        )}
      </div>

      {videoOn && feed && <LiveFeedPanel feed={feed} detail={detail} />}

      <div className="mt-1 flex items-baseline justify-between gap-3">
        <h2 className="m-0 min-w-0 text-[16px] font-semibold">Cameras in {area.label}</h2>
        <span className="shrink-0 text-[12px] whitespace-nowrap text-muted">
          {count} camera{count === 1 ? "" : "s"}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        {area.cams.map((c) => (
          <CamRow key={c.id} cam={c} selected={c.id === cam.id} onPick={() => pickCam(area.name, c.id)} />
        ))}
      </div>
    </div>
  );
}
