// Lightweight liveness probe for Railway's healthcheck. Intentionally does NOT
// touch the database — it only confirms the web server is up and serving.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true });
}
