import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle at .next/standalone for the Cloud Run
  // Docker image. Avoids shipping the full node_modules tree.
  output: "standalone",
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
};

export default nextConfig;
