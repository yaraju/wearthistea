import { getFile } from "@/lib/storage";

// Serves generated artwork. In local dev it reads from /public/generated.
// In production with GCS enabled, it streams from the GCS bucket.
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ path: string[] }> }
) {
  const { path: segments } = await ctx.params;
  const relPath = segments.join("/");

  try {
    const { data, contentType } = await getFile(relPath);
    return new Response(data, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
