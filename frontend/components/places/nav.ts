import type { Screen } from "@/components/app/AppContext";
import type { PlaceRef } from "@/lib/types";

/** The Trip to a place: to our own place by id, else to its point (with what the card needs). */
export function tripTo(p: PlaceRef): Screen {
  return {
    name: "trip",
    to: p.placeId ?? { lat: p.lat, lng: p.lng },
    toName: p.name,
    toPlace: p.placeId ? undefined : { osm: p.osm ?? null, address: p.address ?? null, kind: p.kind ?? null },
  };
}
