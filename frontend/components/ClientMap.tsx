"use client";

import dynamic from "next/dynamic";

import type { MapViewProps } from "./MapView";

// Leaflet touches `window`, so it only loads on the client.
const MapView = dynamic<MapViewProps>(() => import("./MapView"), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse bg-slate-200" />,
});

export default MapView;
