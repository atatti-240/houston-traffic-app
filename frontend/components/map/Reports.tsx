"use client";

/** Driver reports on the map: a pin per report (tap for its card with Still there / Not there),
 * the "pick a spot" tap for the Report sheet and where the report would go, plus the sheet
 * itself. Keeps the reports fresh: refetched whenever the app refetches live data. */

import L from "leaflet";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Marker, Popup, Tooltip, useMap } from "react-leaflet";

import { useApp } from "@/components/app/AppContext";
import ReportCard from "@/components/reports/ReportCard";
import ReportSheet, { PickBanner, ReportFlash } from "@/components/reports/ReportSheet";
import { dataGeneration } from "@/components/screens/Trip/shared";
import { ago } from "@/components/ui";
import {
  REPORT_KINDS,
  closeReport,
  inHouston,
  pickSpot,
  reportsApi,
  selectReport,
  setReports,
  useReports,
  type DriverReport,
} from "@/lib/reports";

function pinIcon(r: DriverReport, selected: boolean) {
  const k = REPORT_KINDS[r.kind];
  const s = selected ? 36 : 30;
  const tip = Math.round(s / 2 + (s / 2) * Math.SQRT2); // the rotated square's corner, below its center
  const html = renderToStaticMarkup(
    <span style={{ position: "relative", display: "block", width: s, height: tip }}>
      <span
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: s,
          height: s,
          borderRadius: "50% 50% 50% 0",
          transform: "rotate(-45deg)",
          background: k.color,
          border: "2px solid #0E1015",
          boxSizing: "border-box",
          boxShadow: selected ? "0 0 0 3px #ECEDEF, 0 3px 10px rgba(0,0,0,0.6)" : "0 2px 8px rgba(0,0,0,0.6)",
        }}
      />
      <svg
        style={{ position: "absolute", left: (s - 16) / 2, top: (s - 16) / 2 }}
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke={k.ink}
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={k.icon} />
      </svg>
    </span>,
  );
  return L.divIcon({ html, className: "cause-icon", iconSize: [s, tip], iconAnchor: [s / 2, tip], popupAnchor: [0, -tip + 4] });
}

const previewIcon = L.divIcon({
  html: renderToStaticMarkup(
    <span
      className="bs-preview"
      style={{ display: "block", width: 18, height: 18, borderRadius: 9, background: "#8FB0FF", border: "3px solid #FFFFFF", boxSizing: "border-box" }}
    />,
  ),
  className: "cause-icon",
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

/** Keep the reports in step with the rest of the live data (the slowdowns object is replaced on every
 * clock-minute poll and every refresh()). */
function useReportsFeed() {
  const { slowdowns } = useApp();
  const generation = dataGeneration(slowdowns);
  useEffect(() => {
    let live = true;
    reportsApi.list().then(
      (r) => live && setReports(r.items),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [generation]);
}

/** While picking: the next tap on the map (not a drag) is the spot. Captured before Leaflet sees it,
 * so tapping a road line or an icon doesn't open it. */
function PickCapture({ picking }: { picking: boolean }) {
  const map = useMap();
  useEffect(() => {
    if (!picking) return;
    const el = map.getContainer();
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const onClick = (e: MouseEvent) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) return; // that was a pan
      e.stopImmediatePropagation();
      e.preventDefault();
      const ll = map.mouseEventToLatLng(e);
      if (inHouston({ lat: ll.lat, lng: ll.lng })) pickSpot({ lat: ll.lat, lng: ll.lng });
    };
    el.addEventListener("pointerdown", onDown, true);
    el.addEventListener("click", onClick, true);
    el.classList.add("bs-picking");
    return () => {
      el.removeEventListener("pointerdown", onDown, true);
      el.removeEventListener("click", onClick, true);
      el.classList.remove("bs-picking");
    };
  }, [picking, map]);
  return null;
}

function ReportPin({ r, sel, pad }: { r: DriverReport; sel: boolean; pad: { top: number; bottom: number } }) {
  const { clock } = useApp();
  const marker = useRef<L.Marker>(null);
  // Open once per selection, like the cause icons (the app re-renders every few seconds, and the
  // popup's autoPan would pull the map back each time).
  useEffect(() => {
    if (!sel) return;
    const t = setTimeout(() => marker.current?.openPopup(), 0);
    return () => clearTimeout(t);
  }, [sel]);
  // Pan it into view once its card is on the page (only then is its size known).
  const shown = useCallback(() => {
    const p = marker.current?.getPopup();
    if (!p) return;
    p.options.autoPan = true;
    p.options.autoPanPaddingTopLeft = L.point(16, pad.top);
    p.options.autoPanPaddingBottomRight = L.point(16, pad.bottom);
    p.update();
    p.options.autoPan = false;
  }, [pad.top, pad.bottom]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const icon = useMemo(() => pinIcon(r, sel), [r.kind, sel]);
  const k = REPORT_KINDS[r.kind];
  return (
    <Marker
      key={String(sel)}
      ref={marker}
      position={[r.lat, r.lng]}
      icon={icon}
      zIndexOffset={sel ? 1200 : 300}
      title={`${r.title}${r.road ? ` on ${r.road}` : ""}, ${r.provenance}`}
      eventHandlers={{
        click: () => selectReport(r.id),
        keypress: (e) => {
          if (e.originalEvent.key !== "Enter" && e.originalEvent.key !== " ") return;
          e.originalEvent.preventDefault();
          selectReport(r.id);
        },
        popupclose: () => sel && selectReport(null),
      }}
    >
      {!sel && (
        <Tooltip direction="top" offset={[0, -34]} className="dark-tip">
          {k.label} · {ago(r.created_at, clock?.now) || "just now"}
        </Tooltip>
      )}
      {sel && (
        <Popup closeButton={false} autoPan={false} className="cause-popup">
          <PinCard r={r} onShown={shown} />
        </Popup>
      )}
    </Marker>
  );
}

/** The pin's card; tells its pin once it is on the page. */
function PinCard({ r, onShown }: { r: DriverReport; onShown: () => void }) {
  useEffect(() => {
    onShown();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <ReportCard r={r} />;
}

export default function Reports() {
  const { mapTime, screen, isDesktop } = useApp();
  const { items, selected, draft, picking, preview } = useReports();
  useReportsFeed();
  // A new screen (back, a tab, a link) closes the sheet and the open card, like the cause icons' popups.
  const screenKey = JSON.stringify(screen);
  const firstScreen = useRef(screenKey);
  useEffect(() => {
    if (screenKey === firstScreen.current) return;
    firstScreen.current = screenKey;
    closeReport();
    selectReport(null);
  }, [screenKey]);
  // Keep an opened card clear of what covers the map on a phone: the Live map's top controls
  // (logo, search, legend: 160px) and the Trip sheet (the lower 64%) with the Report button on it.
  const phone = !isDesktop && typeof window !== "undefined";
  const pad = {
    top: phone && screen.name === "map" ? 164 : 16,
    bottom: phone && screen.name === "trip" ? Math.round(window.innerHeight * 0.64) + 76 : 16,
  };
  return (
    <>
      <style>{`
        .bs-picking, .bs-picking .leaflet-interactive, .bs-picking .leaflet-grab { cursor: crosshair !important; }
        @keyframes bs-preview { 0%, 100% { box-shadow: 0 0 0 0 rgba(143,176,255,0.7); } 50% { box-shadow: 0 0 0 10px rgba(143,176,255,0); } }
        .bs-preview { animation: bs-preview 1.6s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .bs-preview { animation: none; } }
      `}</style>
      {/* Reports describe now: not on the predicted-traffic map */}
      {!mapTime && items.map((r) => <ReportPin key={r.id} r={r} sel={selected === r.id} pad={pad} />)}
      {draft && preview && <Marker position={[preview.lat, preview.lng]} icon={previewIcon} interactive={false} zIndexOffset={1500} />}
      <PickCapture picking={picking} />
      <ReportSheet />
      <PickBanner />
      <ReportFlash />
    </>
  );
}
