"use client";

/**
 * Trip, Walk / Bike / Transit tabs (Drive is components/screens/Trip.tsx). Same place in the layout:
 * a bottom sheet over the map on a phone, the left panel on desktop. No traffic data here.
 *  Walk, Bike: OpenStreetMap routing with turn-by-turn steps (WalkBike.tsx).
 *  Transit: METRO's scheduled timetable, walk + bus / train + walk (Transit.tsx).
 */

import type { ReactNode } from "react";

import { useApp } from "@/components/app/AppContext";
import { BackHeader } from "@/components/ui";
import type { LatLng } from "@/lib/modes";

import { BigLine, ErrorLine, Loading } from "./modeParts";
import { placeName, placePoint } from "./shared";
import Transit from "./Transit";
import TravelTabs from "./TravelTabs";
import WalkBike from "./WalkBike";

export default function ModeTrip() {
  const { screen, places, here, back } = useApp();
  const params = screen.name === "trip" ? screen : null;
  const travel = params?.travel ?? "walk";
  const to = params?.to;
  const toName = params?.toName ?? placeName(places, to);
  const fromName = params?.fromName ?? (params?.from !== undefined ? placeName(places, params.from) : here?.name) ?? "";
  // Where you are (the device, or the default place) when the trip doesn't say where from.
  const start: LatLng | null = params?.from !== undefined ? placePoint(places, params.from) : here ? { lat: here.lat, lng: here.lng } : null;
  const end: LatLng | null = to !== undefined ? placePoint(places, to) : null;
  const same = start && end && Math.abs(start.lat - end.lat) < 2e-4 && Math.abs(start.lng - end.lng) < 2e-4;

  let body: ReactNode;
  if (!start || !end) {
    body = places.length ? (
      <ErrorLine message="We don't know that place yet. Pick one from Where to." />
    ) : (
      <Loading />
    );
  } else if (same) {
    body = (
      <BigLine title="You're already there">
        <span className="text-[14px] text-muted">Pick another destination.</span>
      </BigLine>
    );
  } else if (travel === "transit") {
    body = <Transit start={start} end={end} fromName={fromName} toName={toName} />;
  } else {
    body = <WalkBike key={travel} mode={travel} start={start} end={end} fromName={fromName} toName={toName} />;
  }

  return (
    <div className="flex flex-col gap-4 px-5 pt-3 pb-8 md:pt-6">
      <BackHeader
        onBack={back}
        label={
          <span className="block truncate">
            From {fromName || "…"} → <span className="font-medium text-ink">{toName}</span>
          </span>
        }
      />
      <TravelTabs />
      {body}
    </div>
  );
}
