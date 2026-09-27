"use client";

/** Walk / bike / transit routes on the traffic map: walks dotted, bike rides mint, bus and train
 * rides solid blue, each over a dark casing; the stops to get on and off at as small white dots. */

import { CircleMarker, Pane, Polyline, Tooltip } from "react-leaflet";

import { MODE_COLOR, type ModeRoute } from "@/lib/modes";

const CASING = "#0E1015";
// Round caps on zero-length dashes draw dots; the same spacing at two widths gives each dot a dark rim.
const DOTS = "0 11";

export default function ModeRouteLayer({ route }: { route?: ModeRoute }) {
  return (
    <>
      <Pane name="mode-route" style={{ zIndex: 425 }}>
        {(route?.lines ?? []).map((l, i) =>
          l.kind === "walk" ? (
            <span key={`w-${i}`}>
              <Polyline positions={l.positions} pathOptions={{ color: CASING, weight: 10, opacity: 0.9, dashArray: DOTS, lineCap: "round" }} interactive={false} />
              <Polyline positions={l.positions} pathOptions={{ color: MODE_COLOR.walk, weight: 6, opacity: 1, dashArray: DOTS, lineCap: "round" }} interactive={false} />
            </span>
          ) : (
            <span key={`r-${i}`}>
              <Polyline positions={l.positions} pathOptions={{ color: CASING, weight: 12, opacity: 0.9 }} interactive={false} />
              <Polyline positions={l.positions} pathOptions={{ color: MODE_COLOR[l.kind], weight: 7, opacity: 1 }} interactive={false} />
            </span>
          ),
        )}
      </Pane>
      <Pane name="mode-stops" style={{ zIndex: 630 }}>
        {(route?.stops ?? []).map((s, i) => (
          <CircleMarker
            key={`s-${i}-${s.lat},${s.lng}`}
            center={[s.lat, s.lng]}
            radius={5}
            pathOptions={{ color: CASING, weight: 2.5, fillColor: "#FFFFFF", fillOpacity: 1 }}
          >
            <Tooltip direction="top" className="dark-tip">
              {s.label}
            </Tooltip>
          </CircleMarker>
        ))}
      </Pane>
    </>
  );
}
