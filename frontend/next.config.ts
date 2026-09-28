import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The landing page (public/landing/index.html) at /; the app is at /home (app/home/page.tsx).
  async rewrites() {
    return [{ source: "/", destination: "/landing/index.html" }];
  },
  // Redirects run before rewrites and pages, and keep the request's query string.
  async redirects() {
    return [
      // The app used to live at /: its deep links (/?screen=..., /?demo=1) still open the app.
      { source: "/", has: [{ type: "query", key: "screen" }], destination: "/home", permanent: false },
      { source: "/", has: [{ type: "query", key: "demo" }], destination: "/home", permanent: false },
      // Older addresses of the landing page.
      { source: "/about", destination: "/", permanent: false },
      { source: "/home/index.html", destination: "/", permanent: false },
    ];
  },
};

export default nextConfig;
