// Pure helpers for "which art was this Printrove asset built from" — no DB or
// network, so scripts/test-art-version.ts can unit-test them offline.
//
// Every render/fix/back-layout flip writes a fresh timestamped path for the
// art it changes (see design-render.ts, design-fix.ts, back-layout route), so
// the stored paths double as a version: if they differ from what a
// DesignProduct/upload recorded, that derived asset is stale.

type ArtPaths = { designImagePath: string; backDesignImagePath: string | null };

/** Version of the whole print artwork (front + back) a DesignProduct is built from. */
export function artVersion(design: ArtPaths): string {
  return `${design.designImagePath}|${design.backDesignImagePath ?? ""}`;
}

/** A DesignProduct built from any other art version (or before versions were recorded) is stale. */
export function isDesignProductStale(row: { builtFromArtVersion: string | null }, currentVersion: string): boolean {
  return row.builtFromArtVersion !== currentVersion;
}

/**
 * Whether a stored Printrove upload id may be reused: only if it was
 * uploaded from the art currently at `currentPath`. A missing record (legacy
 * row) is treated as not reusable — one extra upload beats printing old art.
 */
export function isUploadReusable(
  uploadId: string | null,
  uploadedFromPath: string | null,
  currentPath: string | null
): boolean {
  return !!uploadId && !!currentPath && uploadedFromPath === currentPath;
}

/** Fields that reset a DesignProduct so it's rebuilt from scratch (rows are reset, never deleted — Orders reference them). */
export const DESIGN_PRODUCT_RESET = {
  printroveProductId: null,
  printroveVariantId: null,
  mockupFrontUrl: null,
  mockupBackUrl: null,
  builtFromArtVersion: null,
  status: "pending",
  errorMessage: null,
} as const;
