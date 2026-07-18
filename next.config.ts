import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["172.20.10.7"],
  reactStrictMode: true,
  outputFileTracingRoot: process.cwd()
};

export default nextConfig;
