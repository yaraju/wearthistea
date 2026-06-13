import { readFile } from "node:fs/promises";
import path from "node:path";
import { STORAGE_DIR } from "@/lib/storage";

// Serves generated artwork from STORAGE_DIR. In local dev STORAGE_DIR is inside
// /public so these files are served statically and this handler is a no-op
// fallback. On a host with a Volume (STORAGE_DIR=/data) it's the real server.
export const runtime = "nodejs";

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ path: string[] }> }
) {
  const { path: segments } = await ctx.params;

  // Resolve and confirm the target stays inside STORAGE_DIR (no path traversal).
  const root = path.resolve(STORAGE_DIR);
  const abs = path.resolve(root, segments.join("/"));
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const file = await readFile(abs);
    const type = CONTENT_TYPES[path.extname(abs).toLowerCase()] ?? "application/octet-stream";
    return new Response(new Uint8Array(file), {
      headers: {
        "Content-Type": type,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
