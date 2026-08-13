import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Keep native/server-only modules out of the bundle.
  serverExternalPackages: ["sharp", "@prisma/client"],
};

export default nextConfig;
