import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { Storage } from "@google-cloud/storage";

const GCS_BUCKET = process.env.GCS_BUCKET;
const storage = GCS_BUCKET ? new Storage() : null;

// Where generated artwork lives on disk.
//
//   • Local dev (default): ./public/generated — served straight off the public
//     folder, easy to inspect on disk.
//   • Railway / any host with an ephemeral filesystem: set STORAGE_DIR to a
//     mounted **Volume** path (e.g. /data) so artwork survives redeploys and
//     restarts. Files there are served by the /generated/[...path] route
//     handler instead of the static public folder.
//
// Either way the public URL stays /generated/<batchId>/<file>.
export const STORAGE_DIR =
  process.env.STORAGE_DIR ?? path.join(/*turbopackIgnore: true*/ process.cwd(), "public", "generated");

const URL_PREFIX = "/generated";

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

/** Resolve a public /generated/... URL to its absolute path under STORAGE_DIR. */
export function resolveStoragePath(publicPath: string): string {
  const rel = publicPath.replace(/^\/generated\/?/, "");
  return path.join(STORAGE_DIR, rel);
}

/** Save a base64 PNG and return its public URL path (e.g. /generated/abc/foo.png). */
export async function saveImage(
  batchId: string,
  fileName: string,
  base64: string
): Promise<string> {
  const buffer = Buffer.from(base64, "base64");
  const relPath = `${batchId}/${fileName}`;

  if (storage && GCS_BUCKET) {
    const bucket = storage.bucket(GCS_BUCKET);
    const file = bucket.file(relPath);
    await file.save(buffer, {
      contentType: "image/png",
      resumable: false,
    });
  } else {
    const dir = path.join(STORAGE_DIR, batchId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, fileName), buffer);
  }

  return `${URL_PREFIX}/${batchId}/${fileName}`;
}

/** Read a previously-saved image back as base64 (used for Printify upload). */
export async function readImageAsBase64(publicPath: string): Promise<string> {
  const relPath = publicPath.replace(/^\/generated\/?/, "");

  if (storage && GCS_BUCKET) {
    const bucket = storage.bucket(GCS_BUCKET);
    const file = bucket.file(relPath);
    const [content] = await file.download();
    return content.toString("base64");
  } else {
    const buffer = await readFile(resolveStoragePath(publicPath));
    return buffer.toString("base64");
  }
}

/** Get the file content and type for serving via route handler. */
export async function getFile(relPath: string): Promise<{ data: Uint8Array; contentType: string }> {
  const ext = path.extname(relPath).toLowerCase();
  const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";

  if (storage && GCS_BUCKET) {
    const bucket = storage.bucket(GCS_BUCKET);
    const file = bucket.file(relPath);
    const [content] = await file.download();
    return { data: new Uint8Array(content), contentType };
  } else {
    const root = path.resolve(STORAGE_DIR);
    const abs = path.resolve(root, relPath);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error("Invalid path");
    }
    const buffer = await readFile(abs);
    return { data: new Uint8Array(buffer), contentType };
  }
}
