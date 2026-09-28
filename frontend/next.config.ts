import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The landing page (public/home/index.html) at /home; the app stays at /. Checked after the app's own
  // pages and public files, so it can't shadow them.
  async rewrites() {
    return [{ source: "/home", destination: "/home/index.html" }];
  },
  // It lived at /about for a while: keep those links working.
  async redirects() {
    return [{ source: "/about", destination: "/home", permanent: false }];
  },
};

export default nextConfig;
