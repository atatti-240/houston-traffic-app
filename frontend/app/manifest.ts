import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "BlindSpot",
    short_name: "BlindSpot",
    description: "Maps show you traffic. BlindSpot shows you why, and when to leave.",
    // The app is at /home (the landing page is at /). id stays "/", what it was when start_url was "/", so
    // browsers treat this as the same installed app; scope stays "/" so shared trips (/share/...) open in it too.
    id: "/",
    start_url: "/home",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
