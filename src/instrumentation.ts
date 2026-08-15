export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    const { TraceExporter } = await import("@google-cloud/opentelemetry-cloud-trace-exporter");
    const { getNodeAutoInstrumentations } = await import("@opentelemetry/auto-instrumentations-node");
    const { resourceFromAttributes } = await import("@opentelemetry/resources");
    const { SEMRESATTRS_SERVICE_NAME } = await import("@opentelemetry/semantic-conventions");

    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [SEMRESATTRS_SERVICE_NAME]: "wearthistea",
      }),
      traceExporter: new TraceExporter(),
      instrumentations: [
        getNodeAutoInstrumentations({
          // Disable fs as it produces too much noise
          "@opentelemetry/instrumentation-fs": {
            enabled: false,
          },
        }),
      ],
    });

    sdk.start();

    process.on("SIGTERM", () => {
      sdk
        .shutdown()
        .then(() => console.log("Tracing terminated"))
        .catch((error) => console.log("Error terminating tracing", error))
        .finally(() => process.exit(0));
    });
  }
}
