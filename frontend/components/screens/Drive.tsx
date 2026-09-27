"use client";

/**
 * Driving: turn-by-turn for the route picked on Trip (its Start button), with the live you-are-here dot on the map
 * (components/map/LiveLocation), voice, hazard heads-ups and re-plans from where you are (Drive/useNavigation).
 *  Phone: the map fills the screen; the next turn at the top, arrival and End at the bottom.
 *  Desktop: the same in the left panel, the map on the right.
 * End and the system back button both go back to Trip. After a reload it plans again from where you are (or the
 * trip's start), so it never gets stuck.
 */

import { useEffect, useMemo, type ReactNode } from "react";

import { useApp, type MapScene } from "@/components/app/AppContext";
import { drive, useDrive, type DriveTrip } from "@/components/drive/store";
import { Icon, PillButton } from "@/components/ui";
import { fmtDistance } from "@/lib/directions";
import { addMinutesSim, fmtTime } from "@/lib/format";
import { CAUSE, C, ICON } from "@/lib/theme";

import { DRIVE_ICON, FloatButton, Note, PlainBanner, SpeedLimit, TurnBanner } from "./Drive/parts";
import { useNavigation } from "./Drive/useNavigation";

const SIM_SPEEDS = [1, 4, 10];
/** "Then ..." under the banner when the turn after the next comes within this */
const THEN_M = 400;

export default function Drive() {
  const { screen } = useApp();
  const params = screen.name === "drive" ? screen : null;
  const key = JSON.stringify(params);
  const trip = useMemo<DriveTrip | null>(
    () => (params ? { to: params.to, toName: params.toName, from: params.from, fromName: params.fromName, safety: params.safety } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  return trip ? <DriveView key={key} trip={trip} /> : null;
}

function DriveView({ trip }: { trip: DriveTrip }) {
  const { back, clock, scene, setScene, isDesktop } = useApp();
  const nav = useNavigation(trip);
  const follow = useDrive((s) => s.follow);
  const { course, progress: p, route, gps, fix, arrived, reroute, sim } = nav;
  const toName = trip.toName || "your destination";

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
  const offBy = p && fix && fix.source !== "start" && !arrived && p.off > 50 ? p.off : null;

  let banner: ReactNode;
  if (nav.loadError)
    banner = (
      <PlainBanner
        icon={CAUSE.crash.icon}
        tone={C.moderate}
        title="Couldn't get your route"
        sub={
          <>
            {nav.loadError}{" "}
            <button type="button" onClick={nav.retryLoad} className="cursor-pointer font-medium text-accent">
              Try again
            </button>
          </>
        }
      />
    );
  else if (!course) banner = <PlainBanner icon={ICON.car} title="Getting your route…" sub={`To ${toName}`} />;
  else if (arrived) banner = <PlainBanner icon={DRIVE_ICON.pin} tone={C.heavy} title="You've arrived" sub={toName} />;
  else if (!noSteps && (!next || !p)) banner = <PlainBanner icon={DRIVE_ICON.pin} title="Almost there" sub={toName} />;
  else if (noSteps || !next || !p)
    banner = (
      <PlainBanner
        icon={ICON.map}
        title="Follow the blue line"
        sub={
          <>
            Turn-by-turn isn&apos;t available for this route right now.
            {p ? (
              <>
                {" "}
                <span className="font-num">{fmtDistance(p.remainingM)}</span> to go.
              </>
            ) : null}
          </>
        }
      />
    );
  else banner = <TurnBanner step={next.step} distance={p.toNext} then={then} />;

  // ---- status lines ---------------------------------------------------------------------------------
  const notes: ReactNode[] = [];
  if (reroute?.state === "rerouting")
    notes.push(
      <Note key="rr" icon={ICON.clock} tone={C.accent} testId="drive-reroute">
        {reroute.reason === "slowdown" ? `Heavy traffic ahead on ${reroute.road}. Finding a better way…` : "Off the route. Finding a new one…"}
      </Note>,
    );
  else if (reroute?.state === "failed")
    notes.push(
      <Note key="rr" icon={CAUSE.crash.icon} tone={C.moderate} testId="drive-reroute">
        Couldn&apos;t get a new route right now. Still guiding on this one; trying again shortly.
      </Note>,
    );
  else if (reroute?.state === "done")
    notes.push(
      <Note key="rr" icon={ICON.check} tone={C.light} testId="drive-reroute">
        {reroute.same ? `This is still the fastest way, even with the traffic on ${reroute.road}.` : "New route from here."}
      </Note>,
    );
  if (offBy !== null && reroute?.state !== "rerouting")
    notes.push(
      <Note key="off" icon={ICON.locate} tone={C.moderate} testId="drive-off">
        Off the route by <span className="font-num">{fmtDistance(offBy)}</span>
      </Note>,
    );
  if (nav.ahead && !arrived) {
    const { hazard: h, distance } = nav.ahead;
    const icon = h.kind === "train" ? CAUSE.train.icon : h.kind === "closure" ? CAUSE.closure.icon : CAUSE.crash.icon;
    const what =
      h.kind === "train"
        ? h.blocked
          ? `Train blocking ${h.road}`
          : `Rail crossing on ${h.road}: trains often block it now`
        : `${h.kind === "report" ? "Drivers report: " : ""}${h.title}${h.road ? ` on ${h.road}` : ""}`;
    notes.push(
      <Note key="hz" icon={icon} tone={h.kind === "train" && !h.blocked ? C.moderate : C.heavyText} testId="drive-hazard">
        {what} · <span className="font-num">{fmtDistance(distance)}</span>
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
        {gps.state === "unavailable"
          ? "This browser can't share your location, so we're showing the trip from its start."
          : gps.state === "denied"
            ? "Location is off for BlindSpot, so we're showing the trip from its start. Allow it in your browser's site settings to follow along."
            : "Showing the trip from its start. Turn on your location to follow along."}
        {gps.state === "off" && (
          <>
            {" "}
            <button type="button" onClick={gps.allow} className="cursor-pointer font-medium text-accent">
              Use my location
            </button>
          </>
        )}
      </Note>,
    );
  else if (fix?.source === "gps" && fix.accuracy > 100)
    notes.push(
      <Note key="gps" icon={ICON.locate} tone={C.moderate} testId="drive-gps">
        Weak GPS signal: turns may be called late.
      </Note>,
    );

  // ---- controls -------------------------------------------------------------------------------------
  const ask = gps.state === "ask" && !sim.on && (
    <div className="flex flex-col gap-3 rounded-[18px] border border-edge p-4" style={{ background: C.card }} data-testid="drive-ask">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full" style={{ background: C.cardHi, color: C.accent }}>
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

  const voiceLabel = !nav.speech ? "Voice isn't available in this browser" : nav.muted ? "Unmute voice" : "Mute voice";
  const buttons = (
    <>
      {!follow && fix && (
        <FloatButton label="Recenter" onClick={drive.recenter}>
          <Icon d={ICON.locate} size={22} />
        </FloatButton>
      )}
      <FloatButton label={voiceLabel} pressed={nav.muted} disabled={!nav.speech} onClick={nav.toggleMute}>
        <Icon d={nav.muted || !nav.speech ? DRIVE_ICON.voiceOff : DRIVE_ICON.voice} size={22} />
      </FloatButton>
    </>
  );

  const demo = course && !arrived && (
    <div className="flex flex-wrap items-center gap-2">
      {sim.on ? (
        <>
          <span className="rounded-[10px] px-2 py-1 text-[11px] font-bold tracking-[0.08em] uppercase" style={{ background: C.moderate, color: "#11141A" }}>
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
          style={{ borderColor: C.moderate, color: C.moderate }}
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
        ) : (
          <span className="flex items-baseline gap-2">
            <span className="font-num text-[26px] leading-none text-ink">{eta ?? "…"}</span>
            <span className="text-[13px] text-muted">arrival</span>
          </span>
        )}
        {p && !arrived && (
          <span className="font-num text-[14px] text-soft">
            {minutes} min · {fmtDistance(p.remainingM)}
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={end}
        className="flex h-[52px] shrink-0 cursor-pointer items-center gap-2 rounded-[26px] px-6 text-[16px] font-semibold"
        style={{ background: arrived ? C.accent : C.heavy, color: "#11141A" }}
      >
        {arrived ? "Done" : "End"}
      </button>
    </div>
  );

  if (isDesktop)
    return (
      <div className="flex flex-col gap-3 px-5 pt-5 pb-8">
        <span className="text-[13px] text-muted">
          Driving to <span className="font-medium text-ink">{toName}</span>
        </span>
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
      <div className="pointer-events-auto flex flex-col gap-2 px-3 pt-3">
        {banner}
        {notes}
      </div>
      <div className="flex flex-col gap-2.5">
        <div className="flex items-end justify-between px-3">
          <div className="pointer-events-auto">{limit !== null && <SpeedLimit mph={limit} />}</div>
          <div className="pointer-events-auto flex flex-col gap-2.5">{buttons}</div>
        </div>
        <div
          className="pointer-events-auto flex flex-col gap-3 rounded-t-3xl border-t border-line bg-bg px-5 pt-4 pb-6"
          style={{ boxShadow: "0 -4px 24px rgba(0,0,0,0.5)" }}
        >
          {ask}
          {summary}
          {demo}
        </div>
      </div>
    </div>
  );
}
