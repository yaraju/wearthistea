import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

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
  process.env.STORAGE_DIR ?? path.join(process.cwd(), "public", "generated");

const URL_PREFIX = "/generated";

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
  const dir = path.join(STORAGE_DIR, batchId);
  await mkdir(dir, { recursive: true });
  const buffer = Buffer.from(base64, "base64");
  await writeFile(path.join(dir, fileName), buffer);
  return `${URL_PREFIX}/${batchId}/${fileName}`;
}

/** Read a previously-saved image back as base64 (used for Printify upload). */
export async function readImageAsBase64(publicPath: string): Promise<string> {
  const buffer = await readFile(resolveStoragePath(publicPath));
  return buffer.toString("base64");
}
