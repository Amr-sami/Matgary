import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["postgres"],
  allowedDevOrigins: ["192.168.1.42", "192.168.1.*"],
};

export default nextConfig;
