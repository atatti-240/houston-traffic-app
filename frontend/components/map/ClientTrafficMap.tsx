"use client";

import dynamic from "next/dynamic";

// Leaflet touches `window`, so the map only renders in the browser.
const ClientTrafficMap = dynamic(() => import("./TrafficMap"), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-map" />,
});

export default ClientTrafficMap;
