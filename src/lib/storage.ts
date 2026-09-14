import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { Storage } from "@google-cloud/storage";
import { createPreviewImage } from "./image-preview";

const GCS_BUCKET = process.env.GCS_BUCKET;
const storage = GCS_BUCKET ? new Storage() : null;

/** Whether saved images land somewhere that survives a redeploy (GCS) vs.
 * the ephemeral local disk fallback. Callers use this to decide whether a
 * base64 copy in the database is still needed as a lost-file fallback —
 * once GCS is configured, saveImage() either succeeds durably or throws
 * before the caller ever gets a path back, so that fallback stops being
 * necessary and just costs database storage instead. */
export const hasDurableStorage = Boolean(GCS_BUCKET);

// Where generated artwork lives on disk.
//
//   • Local dev (default): ./public/generated — served straight off the public
//     folder, easy to inspect on disk.
//   • Ephemeral filesystem (e.g. Cloud Run): set STORAGE_DIR to a
//     mounted volume path or use Google Cloud Storage (detected via GCS_BUCKET).
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

/** Save a base64 PNG and a downscaled screen-quality preview alongside it —
 * the preview is what customer-facing views render; the full-res path is
 * reserved for provider upload / order placement. See image-preview.ts. */
export async function saveImageWithPreview(
  batchId: string,
  fileName: string,
  base64: string
): Promise<{ path: string; previewPath: string }> {
  const previewFileName = fileName.replace(/(\.[a-z]+)$/i, "-preview$1");
  const [savedPath, previewBase64] = await Promise.all([
    saveImage(batchId, fileName, base64),
    createPreviewImage(base64),
  ]);
  const previewPath = await saveImage(batchId, previewFileName, previewBase64);
  return { path: savedPath, previewPath };
}

/** Save an arbitrary file (e.g. a generated invoice PDF) under a given
 * relative path and return its public URL — like saveImage, but not
 * PNG-specific. */
export async function saveFile(
  relPath: string,
  buffer: Buffer,
  contentType: string
): Promise<string> {
  if (storage && GCS_BUCKET) {
    const bucket = storage.bucket(GCS_BUCKET);
    const file = bucket.file(relPath);
    await file.save(buffer, { contentType, resumable: false });
  } else {
    const dir = path.join(STORAGE_DIR, path.dirname(relPath));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(STORAGE_DIR, relPath), buffer);
  }

  return `${URL_PREFIX}/${relPath}`;
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

/**
 * Whether a public /generated/... path resolves to a REAL object in GCS —
 * not merely a truthy path string, and not the local-disk fallback. Lifted
 * from the ad-hoc `file.exists()` pattern in
 * scripts/migrate-design-image-data-to-gcs.ts:56 into a reusable export so
 * every integrity check (issue #17) goes through identical logic instead of
 * each caller re-deriving the relPath-stripping and exists() call.
 *
 * Returns false — never throws — when there's no bucket to check against
 * (GCS_BUCKET unset, matching this module's own local-disk-fallback
 * decision) or when publicPath doesn't reduce to a real relative path. This
 * is deliberate: a path that's "only ever on local disk" and a path that's
 * unset/malformed are both "not durably stored", which is exactly the
 * distinction this helper exists to make (see AGENTS.md's GCS_BUCKET
 * gotcha — a caller must pass GCS_BUCKET explicitly to actually check the
 * real bucket; with it unset this always reports false, never local state
 * dressed up as a real check).
 *
 * `opts.bucket`/`opts.client` override the module-level bucket name/Storage
 * instance — lets tests exercise "object present", "object absent", and
 * "bucket unset" against a mocked client without needing real GCS
 * credentials or fighting this module's import-time env capture. `client`
 * only needs to be shaped like the bucket()/file()/exists() slice actually
 * used here (GcsClientLike), not a full Storage instance — the real
 * @google-cloud/storage Storage satisfies it structurally, and a test mock
 * doesn't need to stub the other 60+ Bucket/File methods it never calls.
 */
export interface GcsClientLike {
  bucket: (name: string) => {
    file: (relPath: string) => { exists: () => Promise<[boolean]> };
  };
}

export async function existsInGcs(
  publicPath: string,
  opts: {
    bucket?: string;
    client?: GcsClientLike;
  } = {}
): Promise<boolean> {
  const bucketName = opts.bucket ?? GCS_BUCKET;
  const client = opts.client ?? storage;
  if (!bucketName || !client) return false;

  const relPath = publicPath.replace(/^\/generated\/?/, "");
  if (!relPath) return false;

  const file = client.bucket(bucketName).file(relPath);
  const [exists] = await file.exists();
  return exists;
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
