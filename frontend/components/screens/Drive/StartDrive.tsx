"use client";

/** Trip's Start button: opens driving mode on the picked route. It drives now: when the advice is to leave later
 * (arrive-by), it says so ("Start now" and the advised time), since the drive's times are for leaving now. */

import { useApp } from "@/components/app/AppContext";
import { handOff, type DriveTrip } from "@/components/drive/store";
import { Icon, PillButton } from "@/components/ui";
import { primeSpeech } from "@/lib/drive/speech";
import { fmtTime } from "@/lib/format";
import { ICON } from "@/lib/theme";
import type { Route } from "@/lib/types";

import { placeName } from "../Trip/shared";

export default function StartDrive({
  route,
  trip,
  busy = false,
  advisedAt = null,
}: {
  route: Route;
  trip: DriveTrip;
  busy?: boolean;
  /** The advised departure when it's later than now */
  advisedAt?: string | null;
}) {
  const { go } = useApp();
  // Wait for the picked route's turn-by-turn when it's on its way
  const pending = route.directions?.status === "pending";
  // A point without a name reads "Dropped pin" on Trip; driving says "your destination" for it
  const named = typeof trip.to === "string" || trip.toName !== placeName([], trip.to) ? trip : { ...trip, toName: undefined };
  const button = (
    <PillButton
      onClick={() => {
        primeSpeech();
        handOff(named, route);
        go({ name: "drive", ...named });
      }}
      disabled={busy || pending}
      aria-label={`Start driving ${advisedAt ? "now " : ""}to ${named.toName || "your destination"}`}
    >
      <Icon d={ICON.car} size={20} />
      {pending ? "Getting directions…" : advisedAt ? "Start now" : "Start"}
    </PillButton>
  );
  if (!advisedAt) return button;
  return (
    <div className="flex flex-col gap-1.5">
      {button}
      <span className="text-center text-[13px] text-muted">
        Best to leave at <span className="font-num">{fmtTime(advisedAt)}</span>. Starting now, times will differ.
      </span>
    </div>
  );
}
