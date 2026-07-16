import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Avoid picking up a parent lockfile outside this repo.
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
