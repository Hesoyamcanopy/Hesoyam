/**
 * Content Security Policy.
 *
 * Defence in depth behind the plot art, which is rendered through an `img` and
 * so cannot execute script. If a sink is ever reintroduced, `script-src 'self'`
 * stops it running and `connect-src` stops it posting anything it stole.
 *
 * `img-src data:` is required, because the on-chain artwork IS a data URI.
 * Wallet connectors need `wss:` and `https:` on `connect-src`. Google Fonts
 * needs its stylesheet and font hosts. `unsafe-inline` on styles is Next's
 * injected critical CSS, not ours.
 *
 * Report-Only until the wallet paths have been watched in the wild. Flip
 * CSP_ENFORCE=1 to enforce, which is a one line change and should happen before
 * the app holds anything.
 */
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self' https: wss:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'self'",
].join("; ");

const cspHeader = process.env.CSP_ENFORCE === "1"
  ? "Content-Security-Policy"
  : "Content-Security-Policy-Report-Only";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  /**
   * Vercel's newer "services" deploy model, which this project's vercel.json
   * has to opt into to stop its own monorepo auto-detection from rejecting the
   * build, routes every request through one top-level rewrite table. Next's own
   * internal image optimizer at /_next/image does not get first-class treatment
   * under that model the way it does outside it, and 404s in production even
   * though the underlying static file serves fine.
   *
   * There are only ever a handful of small, fixed-size brand images here
   * (the logo, the cover art), so the resizing and format conversion that
   * optimizer buys is not worth chasing an edge case in a genuinely new and
   * still-evolving part of Vercel's config surface. Serving them unoptimized
   * is Next's own supported escape hatch for exactly this situation, and it
   * sidesteps the interaction entirely rather than working around it.
   */
  images: { unoptimized: true },

  async headers() {
    return [
      {
        // The whitepaper must open in the browser, never download. Chrome and
        // Safari default to inline for PDFs, but a CDN in front of this will
        // often not, and "attachment" is the default many of them assume.
        source: "/:file*.pdf",
        headers: [
          { key: "Content-Type", value: "application/pdf" },
          { key: "Content-Disposition", value: "inline" },
          { key: "Cache-Control", value: "public, max-age=3600, must-revalidate" },
        ],
      },
      {
        source: "/:path*",
        headers: [
          { key: cspHeader, value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
    ];
  },

  // The SDK and game-core ship as TypeScript source rather than build output, so the
  // app compiles them itself. That keeps one source of truth for the ABIs.
  transpilePackages: ["@hesoyam/sdk", "@hesoyam/game-core"],

  webpack: (config) => {
    // The `wagmi/connectors` barrel pulls in the Base account connector, which depends
    // on a Coinbase SDK whose ESM subpath exports do not resolve under webpack. We
    // never construct that connector, so the whole subtree is unreachable at runtime.
    // Cutting it at the root keeps the bundle building without dropping injected or
    // WalletConnect support. Remove once the upstream export map is fixed.
    config.resolve.alias = {
      ...config.resolve.alias,
      // Cut the whole subtree at its root rather than chasing each broken subpath.
      "@base-org/account": false,
      // The MetaMask SDK imports React Native storage behind a platform check that
      // webpack cannot see through. It is never reached in a browser build, so
      // resolving it to false removes the warning without changing behaviour.
      "@react-native-async-storage/async-storage": false,
    };

    // Optional dependencies of WalletConnect that are only used server side.
    config.externals.push("pino-pretty", "lokijs", "encoding");

    return config;
  },
};

export default nextConfig;
