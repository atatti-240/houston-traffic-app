"use client";

/**
 * Driving: turn-by-turn for the route picked on Trip (its Start button), with the live you-are-here dot on the map
 * (components/map/LiveLocation), voice, hazard heads-ups and re-plans from where you are (Drive/useNavigation).
 *  Phone: the map fills the screen; the next turn at the top, arrival and End at the bottom.
 *  Desktop: the same in the left panel, the map on the right.
 * End and the system back button both go back to Trip. After a reload it plans again from where you are (or the
 * trip's start), so it never gets stuck.
 */

import { useEffect, useMemo, useRef, type ReactNode } from "react";

import { useApp, type MapScene } from "@/components/app/AppContext";
import { drive, useDrive, type DriveTrip } from "@/components/drive/store";
import { Icon, PillButton } from "@/components/ui";
import { fmtDistance } from "@/lib/directions";
import { addMinutesSim, fmtTime } from "@/lib/format";
import { hazardLabel } from "@/lib/drive/voice";
import { CAUSE, C, ICON, LEVEL, SHADOW } from "@/lib/theme";

import { DRIVE_ICON, FloatButton, InlineAction, Note, PlainBanner, SpeedLimit, TurnBanner } from "./Drive/parts";
import { useNavigation } from "./Drive/useNavigation";

const SIM_SPEEDS = [1, 4, 10];
/** "Then ..." under the banner when the turn after the next comes within this */
const THEN_M = 400;
/** Farther than this off the route, its turns and arrival time mean nothing */
const FAR_OFF_M = 500;

export default function Drive() {
  const { screen } = useApp();
  const params = screen.name === "drive" ? screen : null;
  const key = JSON.stringify(params);
  const trip = useMemo<DriveTrip | null>(
    () => (params ? { to: params.to, toName: params.toName, from: params.from, fromName: params.fromName, safety: params.safety, avoid: params.avoid } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  return trip ? <DriveView key={key} trip={trip} /> : null;
}

function DriveView({ trip }: { trip: DriveTrip }) {
  const { back, clock, scene, setScene, isDesktop, backendDown, refresh } = useApp();
  const nav = useNavigation(trip);
  const follow = useDrive((s) => s.follow);
  const { course, progress: p, route, gps, fix, navFix, arrived, reroute, sim } = nav;
  const toName = trip.toName || "your destination";

  // The screen changed: say where it went (the heading), for screen readers and keyboards
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus({ preventScroll: true }), []);

  // ---- the map: this route and its end; fitted until there's a dot, which the map then follows (LiveLocation) ----
  const hasFix = !!fix;
  const wanted = useMemo<MapScene | null>(() => {
    if (!route) return null;
    const end = route.geometry[route.geometry.length - 1];
    return {
      route: route.geometry,
      points: end ? [{ lat: end[0], lng: end[1], kind: "end", label: toName }] : [],
      markers: false,
      fit: hasFix ? undefined : route.geometry,
      fitPadding: isDesktop ? undefined : { topLeft: [24, 200], bottomRight: [24, 330] },
    };
  }, [route, hasFix, isDesktop, toName]);
  // The app clears the scene when the screen changes (after this screen's first effects): put it back
  useEffect(() => {
    if (wanted && scene !== wanted) setScene(wanted);
  }, [wanted, scene, setScene]);

  const end = () => {
    nav.end();
    back();
  };

  // ---- what's next ----------------------------------------------------------------------------------
  const next = course && p && p.next !== null ? course.steps[p.next] : null;
  const after = course && p && p.next !== null ? course.steps[p.next + 1] : undefined;
  const then = next && after && after.along - next.along <= THEN_M && p && p.toNext <= 2000 ? after.step : null;
  const noSteps = !!course && course.steps.length < 2;
  const eta = clock && p ? fmtTime(addMinutesSim(clock.now, p.remainingS / 60)) : null;
  const minutes = p ? Math.max(arrived ? 0 : 1, Math.round(p.remainingS / 60)) : null;
  const limit = !arrived && p?.segment?.speedLimitMph != null ? p.segment.speedLimitMph : null;
  const offBy = p && navFix && navFix.source !== "start" && !arrived && p.off > 50 ? p.off : null;
  // Far off the route: where you'd join it says nothing about the next turn or when you'd arrive
  const lost = offBy !== null && offBy > FAR_OFF_M;
  const voiceOn = nav.speech && !nav.muted && !nav.voiceBlocked;

  let banner: ReactNode;
  if (nav.loadError)
    banner = (
      <PlainBanner
        icon={CAUSE.crash.icon}
        tone={LEVEL.moderate}
        title="Couldn't get your route"
        sub={
          <>
            {nav.loadError} <InlineAction onClick={nav.retryLoad}>Try again</InlineAction>
          </>
        }
      />
    );
  else if (!course) banner = <PlainBanner icon={ICON.car} title="Getting your route…" sub={`To ${toName}`} />;
  else if (arrived) banner = <PlainBanner icon={DRIVE_ICON.pin} tone={LEVEL.heavy} title="You've arrived" sub={toName} />;
  else if (lost)
    banner = (
      <PlainBanner
        icon={ICON.locate}
        tone={LEVEL.moderate}
        title="Off the route"
        sub={reroute?.state === "rerouting" ? "Finding a way from here…" : "Head back to the blue line, or keep going for a new route from here."}
      />
    );
  else if (!noSteps && (!next || !p)) banner = <PlainBanner icon={DRIVE_ICON.pin} title="Almost there" sub={toName} />;
  else if (noSteps || !next || !p)
    banner = (
      <PlainBanner
        icon={ICON.map}
        title="Follow the blue line"
        sub={
          <>
            {nav.stepsGaveUp && route?.directions?.note ? route.directions.note : "Turn-by-turn isn't available for this route right now."}
            {p ? (
              <span aria-hidden="true">
                {" "}
                <span className="font-num">{fmtDistance(p.remainingM)}</span> to go.
              </span>
            ) : null}
          </>
        }
      />
    );
  else banner = <TurnBanner step={next.step} distance={p.toNext} then={then} live={!voiceOn} />;

  // ---- status lines ---------------------------------------------------------------------------------
  const notes: ReactNode[] = [];
  if (reroute?.state === "rerouting")
    notes.push(
      <Note key="rr" icon={ICON.clock} tone={C.accent} testId="drive-reroute" live>
        {reroute.reason === "slowdown" ? `Heavy traffic ahead on ${reroute.road}. Finding a better way…` : "Off the route. Finding a new one…"}
      </Note>,
    );
  else if (reroute?.state === "failed")
    notes.push(
      <Note key="rr" icon={CAUSE.crash.icon} tone={C.moderateText} testId="drive-reroute" live>
        Couldn&apos;t get a new route right now. Still guiding on this one; trying again shortly.
      </Note>,
    );
  else if (reroute?.state === "done")
    notes.push(
      <Note key="rr" icon={ICON.check} tone={C.lightText} testId="drive-reroute" live>
        {reroute.same ? `This is still the fastest way, even with the traffic on ${reroute.road}.` : "New route from here."}
      </Note>,
    );
  if (offBy !== null && reroute?.state !== "rerouting")
    notes.push(
      <Note key="off" icon={ICON.locate} tone={C.moderateText} testId="drive-off">
        Off the route <span aria-hidden="true">by <span className="font-num">{fmtDistance(offBy)}</span></span>
      </Note>,
    );
  if (nav.ahead && !arrived) {
    const { hazard: h, distance } = nav.ahead;
    const icon = h.kind === "train" ? CAUSE.train.icon : h.kind === "closure" ? CAUSE.closure.icon : CAUSE.crash.icon;
    notes.push(
      <Note key="hz" icon={icon} tone={h.kind === "train" && !h.blocked ? C.moderateText : C.heavyText} testId="drive-hazard">
        {hazardLabel(h)} ·{" "}
        {distance > 0 ? (
          <span className="font-num" aria-hidden="true">
            {fmtDistance(distance)}
          </span>
        ) : (
          "on this road"
        )}
      </Note>,
    );
  }
  if (gps.state === "waiting" && !sim.on)
    notes.push(
      <Note key="gps" icon={ICON.locate} tone={C.muted} testId="drive-gps">
        Finding your location…
      </Note>,
    );
  else if ((gps.state === "denied" || gps.state === "unavailable" || gps.state === "off") && !sim.on)
    notes.push(
      <Note key="gps" icon={ICON.locate} tone={C.muted} testId="drive-gps">
        {fix?.source === "gps"
          ? // Turned off mid-drive: the dot is where you last were, not the trip's start
            gps.state === "denied"
            ? "Location was turned off, so this is where you last were. Allow it again in your browser's site settings to follow along."
            : "Location stopped, so this is where you last were."
          : gps.state === "unavailable"
            ? "This browser can't share your location, so we're showing the trip from its start."
            : gps.state === "denied"
              ? "Location is off for BlindSpot, so we're showing the trip from its start. Allow it in your browser's site settings to follow along."
              : "Showing the trip from its start. Turn on your location to follow along."}
        {gps.state === "off" && (
          <>
            {" "}
            <InlineAction onClick={gps.allow}>Use my location</InlineAction>
          </>
        )}
      </Note>,
    );
  // Phone: the app's "can't reach" banner would cover End, so it's a note here
  if (backendDown && !isDesktop)
    notes.push(
      <Note key="down" icon={CAUSE.crash.icon} tone={C.heavyText} testId="drive-down" live>
        Can&apos;t reach BlindSpot. Still guiding on this route. <InlineAction onClick={refresh}>Retry</InlineAction>
      </Note>,
    );
  if (nav.voiceBlocked && !nav.muted)
    notes.push(
      <Note key="voice" icon={DRIVE_ICON.voiceOff} tone={C.moderateText} testId="drive-voice" live>
        This browser needs a tap before it can speak. <InlineAction onClick={nav.wakeVoice}>Tap to turn on voice</InlineAction>
      </Note>,
    );
  else if (fix?.source === "gps" && fix.accuracy > 100)
    notes.push(
      <Note key="gps" icon={ICON.locate} tone={C.moderateText} testId="drive-gps">
        Weak GPS signal: turns may be called late.
      </Note>,
    );

  // ---- controls -------------------------------------------------------------------------------------
  const ask = gps.state === "ask" && !sim.on && (
    <div className="flex flex-col gap-3 rounded-[18px] border border-edge p-4" style={{ background: C.card }} data-testid="drive-ask">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full" style={{ background: C.sel, color: C.accent }}>
          <Icon d={ICON.locate} size={22} />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[16px] font-semibold text-ink">Follow along with your location?</span>
          <span className="text-[14px] leading-snug text-soft">
            BlindSpot uses it to time each turn and to notice a wrong turn. It stays on this device.
          </span>
        </div>
      </div>
      <div className="flex gap-2">
        <PillButton className="h-11 flex-1 text-[15px]" onClick={gps.allow}>
          Use my location
        </PillButton>
        <PillButton variant="ghost" className="h-11 px-4 text-[15px]" onClick={gps.decline}>
          Not now
        </PillButton>
      </div>
    </div>
  );

  // One steady name with a pressed state ("Mute voice, pressed"): a label that flips as well would contradict it
  const voiceLabel = !nav.speech ? "Voice isn't available in this browser" : "Mute voice";
  const buttons = (
    <>
      {!follow && fix && (
        <FloatButton label="Recenter" onClick={drive.recenter}>
          <Icon d={ICON.locate} size={22} />
        </FloatButton>
      )}
      <FloatButton label={voiceLabel} title={nav.speech && nav.muted ? "Unmute voice" : voiceLabel} pressed={nav.speech ? nav.muted : undefined} disabled={!nav.speech} onClick={nav.toggleMute}>
        <Icon d={nav.muted || !nav.speech ? DRIVE_ICON.voiceOff : DRIVE_ICON.voice} size={22} />
      </FloatButton>
    </>
  );

  const demo = course && !arrived && (
    <div className="flex flex-wrap items-center gap-2">
      {sim.on ? (
        <>
          <span className="rounded-[10px] px-2 py-1 text-[11px] font-bold tracking-[0.08em] uppercase" style={{ background: LEVEL.moderate.bg, color: LEVEL.moderate.fg }}>
            Demo
          </span>
          <span className="text-[13px] text-soft">Simulated</span>
          <button
            type="button"
            onClick={() => nav.setSim((s) => ({ ...s, factor: SIM_SPEEDS[(SIM_SPEEDS.indexOf(s.factor) + 1) % SIM_SPEEDS.length] }))}
            className="font-num h-8 cursor-pointer rounded-[16px] border border-edge-strong px-2.5 text-[13px] text-ink"
            aria-label={`Simulation speed ${sim.factor} times. Change`}
          >
            {sim.factor}×
          </button>
          <button type="button" onClick={nav.wrongTurn} className="h-8 cursor-pointer rounded-[16px] border border-edge-strong px-3 text-[13px] font-medium text-ink">
            Wrong turn
          </button>
          <button
            type="button"
            onClick={() => nav.setSim((s) => ({ ...s, on: false }))}
            className="h-8 cursor-pointer rounded-[16px] px-2 text-[13px] font-medium text-accent"
            aria-label="Stop the simulated drive"
          >
            Stop
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => nav.setSim((s) => ({ ...s, on: true }))}
          className="flex h-9 cursor-pointer items-center gap-2 rounded-[18px] border border-dashed px-3.5 text-[13px] font-medium"
          style={{ borderColor: C.moderateText, color: C.moderateText }}
        >
          <Icon d={ICON.play} size={14} />
          Simulate drive (demo)
        </button>
      )}
    </div>
  );

  const summary = (
    <div className="flex items-center gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5" data-testid="drive-summary">
        {arrived ? (
          <span className="text-[22px] leading-tight font-bold">Arrived</span>
        ) : lost ? (
          <>
            <span className="flex items-baseline gap-2">
              <span className="font-num text-[26px] leading-none text-muted">--:--</span>
              <span className="text-[13px] text-muted">arrival</span>
            </span>
            <span className="text-[14px] text-soft">Times come back with a route from here</span>
          </>
        ) : (
          <span className="flex items-baseline gap-2">
            <span className="font-num text-[26px] leading-none text-ink">{eta ?? "…"}</span>
            <span className="text-[13px] text-muted">arrival</span>
          </span>
        )}
        {p && !arrived && !lost && (
          <span className="font-num text-[14px] text-soft">
            {minutes} min · {fmtDistance(p.remainingM)}
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={end}
        className="flex h-[52px] shrink-0 cursor-pointer items-center gap-2 rounded-[26px] px-6 text-[16px] font-semibold"
        style={arrived ? { background: C.accent, color: C.onAccent } : { background: LEVEL.heavy.bg, color: LEVEL.heavy.fg }}
      >
        {arrived ? "Done" : "End"}
      </button>
    </div>
  );

  if (isDesktop)
    return (
      <div className="flex flex-col gap-3 px-5 pt-5 pb-8">
        <h1 ref={heading} tabIndex={-1} className="text-[13px] font-normal text-muted outline-none">
          Driving to <span className="font-medium text-ink">{toName}</span>
        </h1>
        {banner}
        {notes}
        {ask}
        <div className="flex flex-col gap-3 rounded-[18px] bg-card p-4">{summary}</div>
        <div className="flex items-center gap-2.5">
          {limit !== null && <SpeedLimit mph={limit} />}
          <div className="ml-auto flex gap-2.5">{buttons}</div>
        </div>
        {demo}
      </div>
    );

  // Phone: over the map; only the pieces take touches
  return (
    <div className="flex h-full flex-col justify-between">
      <h1 ref={heading} tabIndex={-1} className="sr-only">
        Driving to {toName}
      </h1>
      <div className="pointer-events-auto flex flex-col gap-2 px-3 pt-3">
        {banner}
        {notes}
      </div>
      <div className="flex flex-col gap-2.5">
        <div className="flex items-end justify-between px-3">
          <div className="pointer-events-auto">{limit !== null && <SpeedLimit mph={limit} />}</div>
          <div className="pointer-events-auto flex flex-col gap-2.5">{buttons}</div>
        </div>
        <div className="pointer-events-auto flex flex-col gap-3 rounded-t-3xl bg-bg px-5 pt-4 pb-6" style={{ boxShadow: SHADOW.up }}>
          {ask}
          {summary}
          {demo}
        </div>
      </div>
    </div>
  );
}
