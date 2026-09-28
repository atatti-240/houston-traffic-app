"use client";

/** Places on the main map: Home, Work and favorites as small markers (a star for favorites), the
 * nearby list's gas stations / chargers / parking, and the open place card (any tapped place). */

import L from "leaflet";
import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { Marker, Popup } from "react-leaflet";

import { useApp } from "@/components/app/AppContext";
import { Icon } from "@/components/ui";
import { C, ICON, SHADOW } from "@/lib/theme";
import type { PlaceRef } from "@/lib/types";

import { PLACE_ICON, STAR } from "./icons";
import { tripTo } from "./nav";
import PlaceCard from "./PlaceCard";
import { POI } from "./pois";
import { pickPlace, setNearbyMarkers, useNearbyMarkers, usePicked, useSaved, type NearbyMarker } from "./store";

const icons = new Map<string, L.DivIcon>();

function glyphIcon(key: string, d: string, color: string, fill: boolean, size: number, bg: string, ring: string): L.DivIcon {
  let icon = icons.get(key);
  if (!icon) {
    const inner = Math.round(size * 0.56);
    const html = renderToStaticMarkup(
      <span
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          background: bg,
          border: `2px solid ${ring}`,
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: SHADOW[1],
        }}
      >
        <svg width={inner} height={inner} viewBox="0 0 24 24" fill={fill ? color : "none"} stroke={color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d={d} />
        </svg>
      </span>,
    );
    icon = L.divIcon({ html, className: "cause-icon", iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
    icons.set(key, icon);
  }
  return icon;
}

function PlacePopup({ place }: { place: PlaceRef }) {
  const { go } = useApp();
  const popup = useRef<L.Popup>(null);
  const card = useRef<HTMLDivElement>(null);
  // The card grows when its details arrive: re-place the popup (and pan it into view).
  useEffect(() => {
    const el = card.current;
    if (!el) return;
    const ro = new ResizeObserver(() => popup.current?.update());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <Popup
      ref={popup}
      position={[place.lat, place.lng]}
      closeButton={false}
      offset={[0, -4]}
      className="cause-popup"
      autoPanPadding={[24, 72]}
      eventHandlers={{ remove: () => pickPlace(null) }}
    >
      <div ref={card} style={{ width: 244 }}>
        <PlaceCard
          place={place}
          onDirections={() => {
            pickPlace(null);
            go(tripTo(place));
          }}
        />
      </div>
    </Popup>
  );
}

/** Phone: the card as a sheet over the bottom of the screen (a popup wouldn't fit between the map's
 * controls and the screen's own sheet), with a pin on the place. */
function PlaceSheet({ place }: { place: PlaceRef }) {
  const { go } = useApp();
  return (
    <>
      <Marker
        position={[place.lat, place.lng]}
        icon={glyphIcon("picked", PLACE_ICON.pin, "#ffffff", false, 30, "#ea4335", "#ffffff")}
        zIndexOffset={1500}
        interactive={false}
      />
      {createPortal(
        <section
          aria-label={place.name}
          className="fade-in fixed inset-x-0 bottom-0 z-[1300] max-h-[70dvh] overflow-y-auto rounded-t-3xl bg-bg px-5 pt-3 pb-6 shadow-up"
        >
          <div className="mb-1 flex justify-end">
            <button
              type="button"
              onClick={() => pickPlace(null)}
              aria-label="Close"
              className="-mr-2 flex h-9 w-9 cursor-pointer items-center justify-center rounded-full text-muted hover:bg-card"
            >
              <Icon d={ICON.close} size={18} />
            </button>
          </div>
          <PlaceCard
            place={place}
            onDirections={() => {
              pickPlace(null);
              go(tripTo(place));
            }}
          />
        </section>,
        document.body,
      )}
    </>
  );
}

function NearbyMarkers({ items, selected }: { items: NearbyMarker[]; selected: string | null }) {
  return (
    <>
      {items.map((m) => {
        const sel = m.key === selected;
        const k = POI[m.poi];
        return (
          <Marker
            key={`nb-${m.key}-${sel}`}
            position={[m.lat, m.lng]}
            icon={glyphIcon(`nb-${m.poi}-${sel}`, k.icon, "#ffffff", false, sel ? 36 : 28, k.color, sel ? C.ink : "#ffffff")}
            zIndexOffset={sel ? 1200 : 900}
            title={m.name}
            eventHandlers={{ click: () => setNearbyMarkers({ items, selected: m.key }) }}
          />
        );
      })}
    </>
  );
}

export default function PlacesLayer() {
  const saved = useSaved();
  const nearby = useNearbyMarkers();
  const picked = usePicked();
  // A card belongs to the screen it was opened on; Escape closes it too.
  const { screen, isDesktop } = useApp();
  const screenKey = JSON.stringify(screen);
  useEffect(() => pickPlace(null), [screenKey]);
  useEffect(() => {
    if (!picked) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && pickPlace(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picked]);
  const pickedKey = picked ? `${picked.osm ?? ""}|${picked.lat}|${picked.lng}` : "";
  const mine = useMemo(
    () => [
      ...(saved.home ? [{ p: saved.home, key: "home", d: PLACE_ICON.home, color: C.accent, fill: false }] : []),
      ...(saved.work ? [{ p: saved.work, key: "work", d: PLACE_ICON.work, color: C.accent, fill: false }] : []),
      ...saved.favorites.map((f) => ({ p: f, key: `fav-${f.key}`, d: PLACE_ICON.star, color: STAR, fill: true })),
    ],
    [saved],
  );
  return (
    <>
      {mine.map(({ p, key, d, color, fill }) => (
        <Marker
          key={key}
          position={[p.lat, p.lng]}
          icon={glyphIcon(`mine-${d === PLACE_ICON.star ? "star" : key}`, d, color, fill, 24, C.marker, color)}
          zIndexOffset={400}
          title={key === "home" ? `Home: ${p.name}` : key === "work" ? `Work: ${p.name}` : p.name}
          eventHandlers={{ click: () => pickPlace(p) }}
        />
      ))}
      <NearbyMarkers items={nearby.items} selected={nearby.selected} />
      {picked && (isDesktop ? <PlacePopup key={pickedKey} place={picked} /> : <PlaceSheet key={pickedKey} place={picked} />)}
    </>
  );
}
