"use client";

/** Trip's Start button: opens driving mode on the picked route. */

import { useApp } from "@/components/app/AppContext";
import { handOff, type DriveTrip } from "@/components/drive/store";
import { Icon, PillButton } from "@/components/ui";
import { ICON } from "@/lib/theme";
import type { Route } from "@/lib/types";

import { placeName } from "../Trip/shared";

export default function StartDrive({ route, trip, busy = false }: { route: Route; trip: DriveTrip; busy?: boolean }) {
  const { go } = useApp();
  // Wait for the picked route's turn-by-turn when it's on its way
  const pending = route.directions?.status === "pending";
  // A point without a name reads "Dropped pin" on Trip; driving says "your destination" for it
  const named = typeof trip.to === "string" || trip.toName !== placeName([], trip.to) ? trip : { ...trip, toName: undefined };
  return (
    <PillButton
      onClick={() => {
        handOff(named, route);
        go({ name: "drive", ...named });
      }}
      disabled={busy || pending}
      aria-label={`Start driving to ${named.toName || "your destination"}`}
    >
      <Icon d={ICON.car} size={20} />
      {pending ? "Getting directions…" : "Start"}
    </PillButton>
  );
}
