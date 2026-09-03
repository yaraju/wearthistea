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
    // Both pull in google-gax, which loads .proto files via a require()
    // expression too dynamic for Turbopack to statically analyze — same
    // "Cannot find module as expression is too dynamic" class of failure
    // as the packages above, just surfaced now that admin routes actually
    // import firebase-admin (Phase 6) instead of just having it installed.
    "firebase-admin",
    "@google-cloud/tasks",
  ],
};

export default nextConfig;
