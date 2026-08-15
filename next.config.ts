import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Keep native/server-only modules out of the bundle.
  serverExternalPackages: [
    "sharp",
    "@prisma/client",
    "@imgly/background-removal-node",
    "onnxruntime-node",
    "@opentelemetry/sdk-node",
    "@opentelemetry/auto-instrumentations-node",
    "@google-cloud/opentelemetry-cloud-trace-exporter",
    "@google-cloud/logging-winston",
  ],
};

export default nextConfig;
