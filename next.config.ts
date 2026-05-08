import type { NextConfig } from "next";

/**
 * Security response headers applied to every path. See `SECURITY.md` for the
 * threat model and rationale for each header.
 *
 * - `Strict-Transport-Security`: 2-year HSTS with preload + subdomains.
 * - `X-Content-Type-Options: nosniff`: prevents MIME-sniffing-based XSS.
 * - `Referrer-Policy: strict-origin-when-cross-origin`: don't leak full URLs
 *   off-site.
 * - `Permissions-Policy`: deny camera/mic; allow geolocation only on same
 *   origin (used by the trip-planner map).
 * - `X-Frame-Options: DENY`: defense in depth against clickjacking. CSP's
 *   `frame-ancestors` is a stricter modern equivalent — we'll add a CSP
 *   later once the Clerk + Pusher inline scripts are inventoried.
 */
const SECURITY_HEADERS = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(self)",
  },
  { key: "X-Frame-Options", value: "DENY" },
];

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle at .next/standalone for the Cloud Run
  // Docker image. Avoids shipping the full node_modules tree.
  output: "standalone",
  // Tree-shake heavy icon / map / flow packages so a single `import { Plus }`
  // from `lucide-react` doesn't pull the whole icon set into the client
  // bundle. `lucide-react` is also on Next's default optimize list, but we
  // name it explicitly to make the intent visible alongside the other two.
  experimental: {
    optimizePackageImports: [
      "lucide-react",
      "@xyflow/react",
      "@react-google-maps/api",
    ],
  },
  images: {
    // Allowlist remote hosts that next/image is allowed to optimize.
    // - Clerk avatars (lh3.googleusercontent.com and other googleusercontent
    //   subdomains)
    // - Google Places photo CDN (lh3.googleusercontent.com, gstatic.com
    //   subdomains)
    remotePatterns: [
      // Covers Clerk avatars (lh3.googleusercontent.com) and any other
      // googleusercontent subdomain.
      { protocol: "https", hostname: "**.googleusercontent.com" },
      { protocol: "https", hostname: "**.gstatic.com" },
    ],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;
