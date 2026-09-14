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

/**
 * Design.<field>Path columns (productImagePath, designImagePath,
 * productPreviewImagePath, designPreviewImagePath, backDesignImagePath,
 * backDesignPreviewImagePath) must always hold a canonical public URL of the
 * exact shape saveImage()/saveFile() return: `${URL_PREFIX}/<batchId>/<file>`.
 * A synchronous, no-API-call sibling to existsInGcs() (#17) — that one
 * confirms bytes are actually durable in the *real bucket*; this one only
 * confirms the *string* isn't already something other than the URL those
 * helpers hand back, and it runs immediately before any DB write instead of
 * requiring a network round trip.
 *
 * DESIGN DECISION (issue #25) — reject-always, not
 * reject-only-when-GCS_BUCKET-is-configured:
 * saveImage()'s GCS branch and its local-disk-fallback branch both build and
 * return this identical `${URL_PREFIX}/<batchId>/<file>` string (see
 * saveImage() above) — the shape does not depend on which backend actually
 * wrote the bytes. So the documented, legitimate local-dev fallback
 * (GCS_BUCKET unset) already produces a conforming path today, and making
 * this check conditional on GCS_BUCKET would add nothing: a
 * reject-only-when-configured version would (a) let a bypassed/malformed
 * path straight into the DB on every machine that happens to run without
 * GCS_BUCKET — i.e. exactly the machines the 127-row incident (AGENTS.md's
 * GCS_BUCKET gotcha) happened on — and (b) still have to unconditionally
 * reject when it IS configured, so the "legitimate local path" carve-out it
 * exists for would never actually fire. Enforcing the shape unconditionally
 * is what actually matches the incident: it catches a raw filesystem path
 * (an absolute STORAGE_DIR path, `./public/generated/...`, a bare filename),
 * base64/data-URI content, or any other hand-built string bypassing
 * storage.ts's own saveImage()/saveFile() helpers — landing in the DB as if
 * it were a real, servable path — regardless of whether GCS_BUCKET happens
 * to be set on the machine running the write. It intentionally does NOT
 * check whether the object actually exists anywhere (that's existsInGcs()'s
 * job, and it can't be done synchronously).
 *
 * `value` may be null/undefined/"" and both pass through untouched: several
 * legitimate call sites persist these columns before art exists yet (a
 * freshly-created Design row uses "" as a not-rendered-yet placeholder) or
 * intentionally leave an optional back-print column unset — neither is the
 * bug this guards against.
 */
// Every current call site produces exactly "/generated/<batchId>/<file>"
// (two segments — see saveImageWithPreview()'s callers, all of which pass a
// bare filename, never a nested one), but this deliberately accepts any
// non-empty path under a given batchId (`[^/]+/.+`) rather than hard-coding
// "exactly two segments": a prod-DB read-only audit to confirm every
// existing row is exactly two segments wasn't available in this run's
// sandbox (read against production blocked), and a narrower regex that's
// wrong about some legacy row's shape would make a legitimate backfill
// write (e.g. backfill-preview-images.ts) throw. Still rejects every local-
// disk-shaped/bypass case this guards against (wrong prefix, no leading
// slash, `./...`, an absolute filesystem path, a missing batchId segment,
// backslashes, `..` traversal) — see scripts/test-storage-path-guard.ts.
const DESIGN_PATH_SHAPE = new RegExp(`^${URL_PREFIX}/[^/]+/.+$`);

/** Reject even a value the shape regex above would accept if it still
 * contains a directory-traversal segment or a Windows path separator —
 * belt-and-suspenders against a bypassed path that happens to start with
 * "/generated/" (e.g. someone string-concatenating URL_PREFIX onto a raw fs
 * path by hand). Deliberately does NOT check for ":" — a legitimate
 * batchId/filename segment can't be ruled out from containing one, and
 * every actual bypass shape this guards against (an absolute fs path, a
 * relative "./..." path, a wrong prefix) is already caught by the prefix
 * check above before this ever runs. */
function hasSuspiciousSegment(value: string): boolean {
  return value.includes("\\") || value.includes("..");
}

export function assertDesignPathShape(fieldName: string, value: string | null | undefined): void {
  if (value === null || value === undefined || value === "") return;
  if (!DESIGN_PATH_SHAPE.test(value) || hasSuspiciousSegment(value)) {
    throw new Error(
      `[storage] Refusing to persist Design.${fieldName} = ${JSON.stringify(value)} — doesn't match the ` +
        `expected "${URL_PREFIX}/<batchId>/<file>" public-URL shape that saveImage()/saveFile() always return ` +
        `(from both their GCS and local-disk-fallback branches). This most likely means a raw filesystem path, ` +
        `base64 data, or a hand-built path bypassed storage.ts's helpers before reaching the DB — see issue #25 ` +
        `and AGENTS.md's GCS_BUCKET gotcha for the incident this guards against.`
    );
  }
}

export const DESIGN_PATH_FIELDS = [
  "productImagePath",
  "designImagePath",
  "productPreviewImagePath",
  "designPreviewImagePath",
  "backDesignImagePath",
  "backDesignPreviewImagePath",
] as const;

export type DesignPathFieldsPatch = Partial<
  Record<(typeof DESIGN_PATH_FIELDS)[number], string | null | undefined>
>;

/**
 * Same check as assertDesignPathShape, but for a whole Prisma
 * create/update `data` payload at once — the shape every call site actually
 * has on hand right before `prisma.design.create(...)`/`.update(...)`. Only
 * checks fields actually present in `data`, so a partial update (e.g. one
 * that only touches `backDesignImagePath`) isn't forced to also supply the
 * other five. Throws (and so aborts the write — call this BEFORE the prisma
 * call, never after) on the first offending field.
 */
export function assertDesignPathFieldsShape(data: DesignPathFieldsPatch): void {
  for (const field of DESIGN_PATH_FIELDS) {
    if (field in data) assertDesignPathShape(field, data[field]);
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
