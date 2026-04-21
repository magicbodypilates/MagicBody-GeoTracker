import type { NextConfig } from "next";

const BASE_PATH = "/geo-tracker";

const nextConfig: NextConfig = {
  output: "standalone",
  basePath: BASE_PATH,
  assetPrefix: BASE_PATH,
  env: {
    NEXT_PUBLIC_BASE_PATH: BASE_PATH,
  },
  experimental: {
    turbopackFileSystemCacheForDev: true,
  },
};

export default nextConfig;
