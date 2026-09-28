"use client";

/** Place bits on the Trip screen: the destination's card (hours, phone, website, star, and
 * whether it's still open when you get there), and "Gas on the way". */

import { useApp, type Screen } from "@/components/app/AppContext";
import { Icon } from "@/components/ui";
import type { LatLngTuple } from "@/lib/types";

import PlaceCard from "./PlaceCard";
import { POI } from "./pois";

type TripScreen = Extract<Screen, { name: "trip" }>;

/** Only for a real place (a search result, a map dot, a saved spot): our own areas have no hours. */
export function TripPlaceCard({ trip, arriveAt }: { trip: TripScreen | null; arriveAt?: string | null }) {
  if (!trip || typeof trip.to === "string") return null;
  const place = {
    name: trip.toName ?? "Dropped pin",
    lat: trip.to.lat,
    lng: trip.to.lng,
    osm: trip.toPlace?.osm ?? null,
    address: trip.toPlace?.address ?? null,
    kind: trip.toPlace?.kind ?? null,
  };
  // To the minute: a re-plan that moves the arrival by seconds doesn't ask again.
  const at = arriveAt ? `${arriveAt.slice(0, 16)}:00` : null;
  return (
    <div className="rounded-[14px] bg-card px-3.5 pt-2.5 pb-2">
      <PlaceCard place={place} compact arriveAt={at} />
    </div>
  );
}

export function GasOnTheWay({ route, toName }: { route: LatLngTuple[] | null | undefined; toName?: string }) {
  const { go } = useApp();
  if (!route || route.length < 2) return null;
  return (
    <button
      type="button"
      onClick={() => go({ name: "nearby", kind: "fuel", route, routeTo: toName })}
      className="flex cursor-pointer items-center gap-2 self-start text-[14px] font-medium text-accent"
    >
      <span className="flex h-6 w-6 items-center justify-center rounded-full" style={{ background: POI.fuel.color }}>
        <Icon d={POI.fuel.icon} size={14} color="#ffffff" width={2.4} />
      </span>
      Gas on the way →
    </button>
  );
}
