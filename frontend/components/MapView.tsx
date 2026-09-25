"use client";

import "leaflet/dist/leaflet.css";
import { useEffect } from "react";
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMap, useMapEvents } from "react-leaflet";

import { fmtTime, pct, scoreColor } from "@/lib/format";
import type { Camera, Crossing, LatLngTuple, Place, Route, Segment } from "@/lib/types";

export const HOUSTON_CENTER: LatLngTuple = [29.7604, -95.3698];

export interface Layers {
  congestion: boolean;
  crash: boolean;
  trains: boolean;
  cameras: boolean;
}

export interface MapViewProps {
  segments: Segment[];
  congestion: Record<string, number>;
  crashRisk: Record<string, number>;
  crossings: Crossing[];
  cameras: Camera[];
  places: Place[];
  route: Route | null;
  alternative: Route | null;
  showAlternative: boolean;
  origin: LatLngTuple | null;
  destination: LatLngTuple | null;
  layers: Layers;
  onMapClick?: (lat: number, lng: number) => void;
  onCameraClick?: (camera: Camera) => void;
  onPlaceClick?: (place: Place) => void;
}

/** Shift a two-point line to the right of travel so both directions are visible. */
function offsetLine(geom: LatLngTuple[], meters = 55): LatLngTuple[] {
  if (geom.length < 2) return geom;
  const [a, b] = [geom[0], geom[geom.length - 1]];
  const cos = Math.cos((a[0] * Math.PI) / 180);
  const dx = (b[1] - a[1]) * cos; // east
  const dy = b[0] - a[0]; // north
  const len = Math.hypot(dx, dy) || 1;
  const k = meters / 111_320;
  // right-hand perpendicular of (dx, dy) is (dy, -dx)
  const dLat = (-dx / len) * k;
  const dLng = (dy / len) * k / cos;
  return geom.map(([lat, lng]) => [lat + dLat, lng + dLng]);
}

function ClickHandler({ onClick }: { onClick?: (lat: number, lng: number) => void }) {
  useMapEvents({ click: (e) => onClick?.(e.latlng.lat, e.latlng.lng) });
  return null;
}

function FitRoute({ route }: { route: Route | null }) {
  const map = useMap();
  useEffect(() => {
    if (route && route.geometry.length > 1) {
      map.fitBounds(route.geometry, { padding: [60, 60], maxZoom: 13 });
    }
  }, [route, map]);
  return null;
}

function crossingColor(c: Crossing): string {
  if (c.live_blocked_until) return "#111827";
  return scoreColor(Math.min(1, c.block_probability * 1.3));
}

export default function MapView(p: MapViewProps) {
  return (
    <MapContainer center={HOUSTON_CENTER} zoom={11} className="h-full w-full" zoomControl={false}>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
        url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
      />
      <ClickHandler onClick={p.onMapClick} />
      <FitRoute route={p.route} />

      {/* Congestion heatmap: each direction drawn slightly offset */}
      {p.layers.congestion &&
        p.segments.map((s) => {
          const score = p.congestion[s.id] ?? 0;
          return (
            <Polyline
              key={`c-${s.id}`}
              positions={offsetLine(s.geometry)}
              pathOptions={{
                color: scoreColor(score),
                weight: s.road_class === "freeway" ? 5 : 3,
                opacity: 0.85,
              }}
            >
              <Tooltip sticky>
                <div className="text-xs">
                  <div className="font-semibold">
                    {s.name} ({s.direction})
                  </div>
                  <div>Congestion {pct(score)}</div>
                  {p.layers.crash && <div>Crash risk {pct(p.crashRisk[s.id] ?? 0)}</div>}
                </div>
              </Tooltip>
            </Polyline>
          );
        })}

      {/* Crash-prone stretches: dashed purple halo */}
      {p.layers.crash &&
        p.segments
          .filter((s) => (p.crashRisk[s.id] ?? 0) >= 0.4 && s.from_node < s.to_node)
          .map((s) => {
            const risk = p.crashRisk[s.id] ?? 0;
            return (
              <Polyline
                key={`x-${s.id}`}
                positions={s.geometry}
                pathOptions={{ color: "#7c3aed", weight: 14, opacity: 0.15 + 0.4 * risk, dashArray: "2 10", lineCap: "round" }}
              >
                <Tooltip sticky>
                  <span className="text-xs">
                    {s.name}: crash risk {pct(risk)}
                  </span>
                </Tooltip>
              </Polyline>
            );
          })}

      {/* Alternative route (dimmed) and chosen route */}
      {p.showAlternative && p.alternative && (
        <Polyline
          positions={p.alternative.geometry}
          pathOptions={{ color: "#64748b", weight: 7, opacity: 0.6, dashArray: "8 8" }}
        />
      )}
      {p.route && (
        <>
          <Polyline positions={p.route.geometry} pathOptions={{ color: "#ffffff", weight: 11, opacity: 0.9 }} />
          <Polyline positions={p.route.geometry} pathOptions={{ color: "#2563eb", weight: 7, opacity: 0.95 }} />
        </>
      )}

      {/* Rail crossings */}
      {p.layers.trains &&
        p.crossings.map((c) => (
          <CircleMarker
            key={c.id}
            center={[c.lat, c.lng]}
            radius={c.live_blocked_until ? 11 : 7 + 6 * c.block_probability}
            pathOptions={{
              color: c.live_blocked_until ? "#dc2626" : "#1f2937",
              weight: c.live_blocked_until ? 3 : 1.5,
              fillColor: crossingColor(c),
              fillOpacity: 0.9,
              className: c.live_blocked_until ? "pulse" : undefined,
            }}
          >
            <Tooltip direction="top">
              <div className="text-xs">
                <div className="font-semibold">🚆 {c.name}</div>
                {c.live_blocked_until ? (
                  <div className="text-red-600">Blocked now, until {fmtTime(c.live_blocked_until)}</div>
                ) : (
                  <div>
                    {pct(c.block_probability)} chance of a train · ~{c.expected_delay_min} min expected
                  </div>
                )}
                <div className="text-slate-500">{c.rail_line} line</div>
              </div>
            </Tooltip>
          </CircleMarker>
        ))}

      {/* Cameras */}
      {p.layers.cameras &&
        p.cameras.map((cam) => (
          <CircleMarker
            key={cam.id}
            center={cam.kind === "train" ? [cam.lat + 0.0012, cam.lng + 0.0012] : [cam.lat, cam.lng]}
            radius={5}
            pathOptions={{ color: "#0f172a", weight: 1, fillColor: cam.kind === "train" ? "#f59e0b" : "#0ea5e9", fillOpacity: 1 }}
            eventHandlers={{ click: () => p.onCameraClick?.(cam) }}
          >
            <Tooltip>
              <span className="text-xs">📷 {cam.name}</span>
            </Tooltip>
          </CircleMarker>
        ))}

      {/* Named places */}
      {p.places.map((pl) => (
        <CircleMarker
          key={pl.id}
          center={[pl.lat, pl.lng]}
          radius={4}
          pathOptions={{ color: "#0f172a", weight: 1, fillColor: "#ffffff", fillOpacity: 1 }}
          eventHandlers={{ click: () => p.onPlaceClick?.(pl) }}
        >
          <Tooltip permanent direction="right" offset={[6, 0]} className="place-label">
            {pl.name}
          </Tooltip>
        </CircleMarker>
      ))}

      {p.origin && (
        <CircleMarker center={p.origin} radius={9} pathOptions={{ color: "#fff", weight: 3, fillColor: "#16a34a", fillOpacity: 1 }}>
          <Tooltip>Start</Tooltip>
        </CircleMarker>
      )}
      {p.destination && (
        <CircleMarker center={p.destination} radius={9} pathOptions={{ color: "#fff", weight: 3, fillColor: "#dc2626", fillOpacity: 1 }}>
          <Tooltip>Destination</Tooltip>
        </CircleMarker>
      )}
    </MapContainer>
  );
}
