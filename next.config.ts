import type { NextConfig } from "next";

const apiOrigin = (process.env.API_PROXY_TARGET ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/$/, "");

// Cover artwork was re-encoded to WebP (10–70x smaller, visually identical). Paths stored in the
// database (Module.coverPath / ScheduleEvent.coverPath) or cached in old HTML may still point at
// the original PNG/JPG names, so those keep resolving to the WebP file.
const LEGACY_COVER_REWRITES = [
  "welcome-cover", "market-logic-cover", "eq-point-narrative-cover", "qa-cover",
  "delivery-ab-part-12-cover", "delivery-ab-part-3-cover", "entry-models-qa-cover",
  "backtest-performance", "auth-background",
].map((name) => ({ source: `/${name}.png`, destination: `/${name}.webp` })).concat([
  { source: "/pre-session-cover.jpg", destination: "/pre-session-cover.webp" },
  { source: "/event-covers/pre-session-cover.jpg", destination: "/event-covers/pre-session-cover.webp" },
]);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return {
      // beforeFiles: must win over the original PNG/JPG still sitting in public/, which Next
      // would otherwise serve first (afterFiles rewrites only run when no static file matches).
      beforeFiles: LEGACY_COVER_REWRITES,
      afterFiles: [
        {
          source: "/api/:path*",
          destination: `${apiOrigin}/api/:path*`,
        },
      ],
      fallback: [],
    };
  },
};

export default nextConfig;
