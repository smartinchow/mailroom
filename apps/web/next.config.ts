import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // Monorepo: trace files from the repo root so the standalone bundle is complete.
  outputFileTracingRoot: path.join(__dirname, "../.."),
};

export default nextConfig;
