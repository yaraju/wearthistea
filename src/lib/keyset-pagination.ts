/**
 * Shared keyset-pagination cursor for Design listings, ordered by
 * (createdAt desc, id desc) — stable under concurrent inserts, unlike
 * offset pagination. No pagination precedent existed elsewhere in this repo
 * (every prior list route is a flat `take: N`), so this is the one shape
 * both /api/account/designs and /api/admin/designs/catalog build on.
 */
export interface Cursor {
  createdAt: string; // ISO
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

export function decodeCursor(raw: string | null): Cursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed?.createdAt === "string" && typeof parsed?.id === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

/** Prisma `where` fragment for "strictly after this cursor" on (createdAt desc, id desc). */
export function cursorWhereClause(cursor: Cursor | null) {
  if (!cursor) return {};
  return {
    OR: [
      { createdAt: { lt: new Date(cursor.createdAt) } },
      { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
    ],
  };
}
