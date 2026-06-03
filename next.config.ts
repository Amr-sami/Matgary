import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["postgres"],
  allowedDevOrigins: ["192.168.1.42", "192.168.1.*"],
  // Standalone output bundles only the runtime files we need into
  // .next/standalone, which the production Dockerfile copies. Cuts the image
  // from ~1.2GB to ~280MB and starts in <1s.
  output: "standalone",
  // Lint runs as an informational step in CI (.github/workflows/*.yml — see
  // task.md §4 "Cleanup pre-existing lint errors"). The build shouldn't
  // block on the same 194-error backlog. Remove this once the backlog is
  // empty and lint becomes a true gate.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
