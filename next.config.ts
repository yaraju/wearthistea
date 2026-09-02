import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Keep native/server-only modules out of the bundle.
  serverExternalPackages: [
    "sharp",
    "@prisma/client",
    "@imgly/background-removal-node",
    "onnxruntime-node",
    // satori pulls in harfbuzzjs, whose emscripten-generated loader locates
    // hb.wasm relative to its own __dirname at runtime — bundling it rewrites
    // that path and breaks the lookup (ENOENT), same class of problem as the
    // native packages above.
    "satori",
    "@opentelemetry/sdk-node",
    "@opentelemetry/auto-instrumentations-node",
    "@google-cloud/opentelemetry-cloud-trace-exporter",
    "@google-cloud/logging-winston",
  ],
};

export default nextConfig;
