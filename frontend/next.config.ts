import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The landing page (public/home/index.html) at /home; the app stays at /.
  async rewrites() {
    return [{ source: "/home", destination: "/home/index.html" }];
  },
};

export default nextConfig;
