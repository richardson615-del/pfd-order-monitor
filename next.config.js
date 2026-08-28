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
