import type { NextConfig } from "next";

const API_URL = process.env.API_URL ?? "http://127.0.0.1:8010";

const nextConfig: NextConfig = {
  // Same-origin API so the session cookie just works. `fallback` so app/api/jobs/[id]/file/route.ts
  // (streaming upload) wins over the rewrite; rewrites copy request bodies into memory and cut them at 10 MB.
  async rewrites() {
    return { beforeFiles: [], afterFiles: [], fallback: [{ source: "/api/:path*", destination: `${API_URL}/api/:path*` }] };
  },
  experimental: {
    // Rewrites to an external host time out after 30 s by default, which cuts off long media streams
    // (a paused video keeps its range request open).
    proxyTimeout: 4 * 60 * 60 * 1000,
  },
  devIndicators: false,
  output: "standalone",
};

export default nextConfig;
