import { Langfuse } from "langfuse";

const publicKey = process.env.NEXT_PUBLIC_LANGFUSE_PUBLIC_KEY || process.env.LANGFUSE_PUBLIC_KEY;
const secretKey = process.env.LANGFUSE_SECRET_KEY;
const baseUrl = process.env.LANGFUSE_BASEURL || "https://cloud.langfuse.com";

export const langfuse = new Langfuse({
  publicKey,
  secretKey,
  baseUrl,
  flushAt: 1, // Ensure logs are sent immediately in serverless environment
});

// Helper to get trace ID from headers or generate new one
export function getTraceId(req?: Request): string | undefined {
  if (!req) return undefined;
  // Try to get from GCP header first
  const gcpTrace = req.headers.get("x-cloud-trace-context");
  if (gcpTrace) {
    return gcpTrace.split("/")[0];
  }
  return undefined;
}
