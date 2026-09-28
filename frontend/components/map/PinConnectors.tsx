"use client";

/** The last bit on foot: when a pin sits off the road (an address, a place tapped on the map, a dropped pin), a
 * short dotted line joins the drawn route to it, like Google Maps does. Dots the way the Walk tab draws walks
 * (round caps on zero-length dashes, each dot over a slightly bigger one for a rim), in theme colors. */

import { Pane, Polyline } from "react-leaflet";

import type { MapPoint, MapScene } from "@/components/app/AppContext";
import { C } from "@/lib/theme";
import type { LatLngTuple } from "@/lib/types";

// Closer than this, the pin already sits on the line: nothing to join.
const MIN_GAP_M = 15;
const DOTS = "0 10";

function meters(a: LatLngTuple, b: LatLngTuple): number {
  const cos = Math.cos((((a[0] + b[0]) / 2) * Math.PI) / 180);
  return Math.hypot(b[0] - a[0], (b[1] - a[1]) * cos) * 111_320;
}

const at = (p: MapPoint): LatLngTuple => [p.lat, p.lng];

/** The gaps to draw: route start to the start pin, each stop to the legs on either side, route end to the end pin. */
export function pinGaps(lines: LatLngTuple[][], points: MapPoint[] = []): [LatLngTuple, LatLngTuple][] {
  const drawn = lines.filter((l) => l.length > 0);
  if (!drawn.length) return [];
  const pairs: [LatLngTuple, LatLngTuple][] = [];
  const start = points.find((p) => p.kind === "start");
  const end = points.find((p) => p.kind === "end");
  if (start) pairs.push([drawn[0][0], at(start)]);
  // A multi-stop plan: leg i ends at stop i and leg i + 1 starts there.
  const stops = points.filter((p) => p.kind === "stop");
  if (stops.length && drawn.length === stops.length + 1) {
    stops.forEach((s, i) => {
      pairs.push([drawn[i][drawn[i].length - 1], at(s)], [drawn[i + 1][0], at(s)]);
    });
  }
  const last = drawn[drawn.length - 1];
  if (end) pairs.push([last[last.length - 1], at(end)]);
  return pairs.filter(([a, b]) => meters(a, b) > MIN_GAP_M);
}

/** The scene's pins that a route should reach (for fitting the map to the route and its ends). */
export function scenePins(scene: MapScene | null | undefined): LatLngTuple[] {
  if (!scene?.route && !scene?.legs) return [];
  return (scene.points ?? []).map(at);
}

/** Dotted lines from the route's ends to its pins. `lines`: the drawn route, or a plan's legs in order. */
export default function PinConnectors({ lines, points, pane = "pin-connectors" }: { lines: LatLngTuple[][]; points?: MapPoint[]; pane?: string }) {
  const gaps = pinGaps(lines, points);
  return (
    // Over the route lines (420), under the pins (640)
    <Pane name={pane} style={{ zIndex: 430 }}>
      {gaps.map((g, i) => (
        <span key={`g-${i}-${g[1][0]},${g[1][1]}`}>
          <Polyline positions={g} pathOptions={{ color: C.halo, weight: 9, opacity: 1, dashArray: DOTS, lineCap: "round" }} interactive={false} />
          <Polyline positions={g} pathOptions={{ color: C.muted, weight: 5.5, opacity: 1, dashArray: DOTS, lineCap: "round" }} interactive={false} />
        </span>
      ))}
    </Pane>
  );
}
