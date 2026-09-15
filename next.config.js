/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // @napi-rs/canvas is a native binary. Webpack cannot bundle a .node file,
    // and trying to fails the BUILD rather than the request - which is the
    // good outcome, but only if it is externalised here.
    serverComponentsExternalPackages: ["@napi-rs/canvas"],
    // The bundled ticket font is read from disk at render time, so it has to
    // be traced into the serverless function. Without this the font silently
    // fails to register and the header rasterizes with fallback glyphs.
    outputFileTracingIncludes: {
      "/api/print/epson": ["./assets/fonts/**"],
    },
  },
  /**
   * The build this bundle came from, inlined into the client.
   *
   * Compared against what /api/version reports at RUNTIME - which is served
   * by the CURRENT deployment - so a tablet running yesterday's JavaScript
   * can notice that fact itself. Without it, a page that stays open for weeks
   * (which is what a kiosk is) keeps whatever it loaded until somebody
   * manually relaunches the app, and there is no reason anyone ever would.
   *
   * "dev" locally, where the two always agree and nothing reloads.
   */
  env: {
    NEXT_PUBLIC_BUILD_ID: process.env.VERCEL_GIT_COMMIT_SHA || "dev",
  },
  async headers() {
    return [
      {
        // Service worker must be served from root with no-cache so updates are picked up
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
