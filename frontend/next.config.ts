import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The landing page is one static file, public/about/index.html: serve it at /about (/about/ redirects here).
  // Checked after the app's own pages and public files, so it can't shadow them.
  async rewrites() {
    return [{ source: "/about", destination: "/about/index.html" }];
  },
};

export default nextConfig;
