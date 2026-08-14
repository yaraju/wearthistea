import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Keep native/server-only modules out of the bundle.
  serverExternalPackages: ["sharp", "@prisma/client", "@imgly/background-removal-node", "onnxruntime-node"],
};

export default nextConfig;
