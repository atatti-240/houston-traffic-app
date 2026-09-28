"use client";

/**
 * You are here: the blue dot, live. It glides to each GPS fix, with an accuracy circle (capped) and a
 * heading cone once the direction is known. Without a live fix in Houston it sits still at `fallback`
 * (the app's default place), so there's always exactly one dot.
 *
 * Follow: the locate button centers on you and keeps you in view until you drag the map away
 * (`follow="button"`). The small Where to map always follows (`follow="always"`).
 *
 * Leaflet layers are made once and moved in place, so a fix never re-creates (or flickers) the dot.
 */

import L from "leaflet";
import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";

import { inHouston, stopFollowing, useFollow, useLiveFix } from "@/components/app/liveLocation";
import type { LatLngTuple } from "@/lib/types";

/** Google's blue, the same in both themes */
const BLUE = "#1a73e8";
const HALO = "#4285f4";
/** A 5 km fix shouldn't paint the city: the circle stops here (m) */
const MAX_ACCURACY_M = 300;
const GLIDE_MS = 700;
/** Further than this (degrees, about 2 km), jump instead of gliding */
const JUMP_DEG = 0.02;
const SIZE = 56;

let uid = 0;

function dotHtml(id: string) {
  const h = SIZE / 2;
  return `<div style="position:relative;width:${SIZE}px;height:${SIZE}px;pointer-events:none">
<svg data-cone width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" style="position:absolute;inset:0;opacity:0;transition:transform .5s ease-out,opacity .3s" aria-hidden="true">
<defs><radialGradient id="${id}" cx="${h}" cy="${h}" r="${h}" gradientUnits="userSpaceOnUse"><stop offset="0.25" stop-color="${HALO}" stop-opacity="0.6"/><stop offset="1" stop-color="${HALO}" stop-opacity="0"/></radialGradient></defs>
<path d="M${h} ${h} L${h - 13} 2 A${h} ${h} 0 0 1 ${h + 13} 2 Z" fill="url(#${id})"/>
</svg>
<span style="position:absolute;left:${h - 10}px;top:${h - 10}px;width:20px;height:20px;box-sizing:border-box;border-radius:50%;background:${BLUE};border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35)"></span>
</div>`;
}

function ensurePane(map: L.Map, name: string, z: number) {
  const p = map.getPane(name) ?? map.createPane(name);
  p.style.zIndex = String(z);
  p.style.pointerEvents = "none";
}

const ease = (t: number) => 1 - (1 - t) ** 3;

export default function LiveDot({ fallback, follow }: { fallback: LatLngTuple | null; follow: "button" | "always" }) {
  const map = useMap();
  const fix = useLiveFix();
  const { on: followOn, seq } = useFollow();
  const live = fix && inHouston(fix) ? fix : null;
  const target: LatLngTuple | null = live ? [live.lat, live.lng] : fallback;
  const radius = live ? Math.min(live.accuracy, MAX_ACCURACY_M) : 0;
  const heading = live?.heading ?? null;
  const following = follow === "always" || followOn;

  const layers = useRef<{ marker: L.Marker; circle: L.Circle } | null>(null);
  const shown = useRef<{ pos: LatLngTuple; radius: number } | null>(null);
  const frame = useRef(0);
  const rot = useRef<number | null>(null);
  const selfMove = useRef(false);
  const targetRef = useRef(target);
  useEffect(() => {
    targetRef.current = target;
  });

  // The layers, once per map.
  useEffect(() => {
    ensurePane(map, "you-accuracy", 405); // over the traffic lines, under the routes
    ensurePane(map, "you", 615); // over routes and cause icons, under trip pins
    const marker = L.marker([0, 0], {
      icon: L.divIcon({
        className: "",
        html: dotHtml(`you-cone-${++uid}`),
        iconSize: [SIZE, SIZE],
        iconAnchor: [SIZE / 2, SIZE / 2],
      }),
      pane: "you",
      interactive: false,
      keyboard: false,
    });
    const circle = L.circle([0, 0], {
      radius: 0,
      pane: "you-accuracy",
      interactive: false,
      color: HALO,
      weight: 1,
      opacity: 0.35,
      fillColor: HALO,
      fillOpacity: 0.12,
    });
    layers.current = { marker, circle };
    return () => {
      cancelAnimationFrame(frame.current);
      marker.remove();
      circle.remove();
      layers.current = null;
      shown.current = null;
    };
  }, [map]);

  // Glide to each new position (and grow / shrink the circle with it).
  const lat = target?.[0];
  const lng = target?.[1];
  useEffect(() => {
    const l = layers.current;
    if (!l) return;
    if (lat === undefined || lng === undefined) {
      l.marker.remove();
      l.circle.remove();
      shown.current = null;
      return;
    }
    const to: LatLngTuple = [lat, lng];
    if (!map.hasLayer(l.marker)) l.marker.addTo(map);
    if (radius > 0 && !map.hasLayer(l.circle)) l.circle.addTo(map);
    else if (radius === 0) l.circle.remove();
    const from = shown.current;
    cancelAnimationFrame(frame.current);
    const put = (pos: LatLngTuple, r: number) => {
      l.marker.setLatLng(pos);
      l.circle.setLatLng(pos);
      l.circle.setRadius(r);
      shown.current = { pos, radius: r };
    };
    if (!from || Math.abs(from.pos[0] - to[0]) + Math.abs(from.pos[1] - to[1]) > JUMP_DEG) {
      put(to, radius);
      return;
    }
    const t0 = performance.now();
    const step = (now: number) => {
      const t = ease(Math.min(1, (now - t0) / GLIDE_MS));
      put([from.pos[0] + (to[0] - from.pos[0]) * t, from.pos[1] + (to[1] - from.pos[1]) * t], from.radius + (radius - from.radius) * t);
      if (t < 1) frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  }, [map, lat, lng, radius]);

  // The heading cone: shortest way round, hidden while the direction is unknown.
  useEffect(() => {
    const cone = layers.current?.marker.getElement()?.querySelector<SVGElement>("[data-cone]");
    if (!cone) return;
    if (heading === null) {
      cone.style.opacity = "0";
      return;
    }
    const prev = rot.current ?? heading;
    const next = prev + ((((heading - prev) % 360) + 540) % 360) - 180;
    rot.current = next;
    cone.style.transform = `rotate(${next}deg)`;
    cone.style.opacity = "1";
  }, [heading, lat, lng]);

  // Following: keep the map on you as you move.
  useEffect(() => {
    if (!following || lat === undefined || lng === undefined) return;
    selfMove.current = true;
    map.panTo([lat, lng], {
      animate: true,
      duration: GLIDE_MS / 1000,
      easeLinearity: 0.5,
    });
  }, [map, following, follow, lat, lng]);

  // The locate button (again): center on you, a street-level zoom.
  useEffect(() => {
    if (follow !== "button" || seq === 0) return;
    const t = targetRef.current;
    if (!t) return;
    selfMove.current = true;
    map.setView(t, Math.max(map.getZoom(), 15), { animate: true });
  }, [map, follow, seq]);

  // Dragging the map (or anything else moving you out of view) stops following.
  useEffect(() => {
    if (follow !== "button") return;
    const onDrag = () => stopFollowing();
    const onEnd = () => {
      if (selfMove.current) {
        selfMove.current = false;
        return;
      }
      const t = targetRef.current;
      if (t && !map.getBounds().pad(-0.2).contains(t)) stopFollowing();
    };
    map.on("dragstart", onDrag);
    map.on("moveend", onEnd);
    return () => {
      map.off("dragstart", onDrag);
      map.off("moveend", onEnd);
    };
  }, [map, follow]);

  return null;
}
