import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep native/server-only modules out of the bundle.
  serverExternalPackages: ["sharp", "@prisma/client"],
};

export default nextConfig;
