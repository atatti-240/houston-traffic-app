"use client";

import dynamic from "next/dynamic";

// Leaflet touches `window`, so it only loads on the client.
const MapView = dynamic(() => import("./MapView"), { ssr: false });

export default MapView;
