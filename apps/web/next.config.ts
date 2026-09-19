import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["postgres"],
  allowedDevOrigins: ["192.168.1.42", "192.168.1.61"],
  // Standalone output bundles only the runtime files we need into
  // .next/standalone, which the production Dockerfile copies. Cuts the image
  // from ~1.2GB to ~280MB and starts in <1s.
  output: "standalone",
  // H07 — don't advertise the framework in response headers.
  poweredByHeader: false,
};

export default nextConfig;
