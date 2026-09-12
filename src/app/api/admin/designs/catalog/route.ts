import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { searchDesignsByText, type EmbeddingField } from "@/lib/design-search";
import { decodeCursor, encodeCursor, cursorWhereClause } from "@/lib/keyset-pagination";

export const runtime = "nodejs";

const PAGE_SIZE = 30;

const CATALOG_INCLUDE = {
  batch: { select: { keyword: true } },
  createdByUser: { select: { email: true } },
  designProducts: {
    select: { id: true, category: true, color: true, approvalStatus: true, status: true },
  },
} satisfies Prisma.DesignInclude;

type CatalogDesign = Prisma.DesignGetPayload<{ include: typeof CATALOG_INCLUDE }>;

function toCatalogItem(
  d: CatalogDesign,
  extra?: { distance: number; matchedField: EmbeddingField | "exact" }
) {
  return {
    id: d.id,
    slug: d.slug,
    title: d.title,
    phrase: d.phrase,
    blurb: d.blurb,
    visualConcept: d.visualConcept,
    designPrompt: d.designPrompt,
    productPrompt: d.productPrompt,
    batchId: d.batchId,
    keyword: d.batch.keyword,
    status: d.status,
    errorMessage: d.errorMessage,
    category: d.category,
    variantColor: d.variantColor,
    style: d.style,
    createdAt: d.createdAt.toISOString(),
    createdByUserId: d.createdByUserId,
    createdByEmail: d.createdByUser?.email ?? null,
    designImagePath: d.designImagePath,
    productImagePath: d.productImagePath,
    designPreviewImagePath: d.designPreviewImagePath,
    productPreviewImagePath: d.productPreviewImagePath,
    backDesignPreviewImagePath: d.backDesignPreviewImagePath,
    designProducts: d.designProducts,
    ...(extra ? { distance: extra.distance, matchedField: extra.matchedField } : {}),
  };
}

/**
 * Permanent, browsable catalog of every design ever generated — for admin
 * quality review/debugging, distinct from the pending-review queue (which
 * only shows designs blocking a real order). Two contracts:
 *
 * Browse (no `q`): keyset pagination, `{ designs, nextCursor }`.
 * Search (`q` present): ranked top-K, always `nextCursor: null` (documented
 * explicitly in the response — callers must not assume a cursor exists).
 * `mode=text` (default) is a literal substring match against the brew
 * keyword/title/phrase — the common "find the exact design from this
 * prompt" QA lookup. `mode=semantic` ranks by embedding similarity instead.
 */
export async function GET(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim();
  const mode = url.searchParams.get("mode") === "semantic" ? "semantic" : "text";
  const status = url.searchParams.get("status") || undefined;
  const limit = Math.min(Number(url.searchParams.get("limit")) || PAGE_SIZE, 100);

  if (q) {
    if (mode === "semantic") {
      const hits = await searchDesignsByText(q, { limit });
      if (hits.length === 0) return NextResponse.json({ designs: [], nextCursor: null });
      const rows = await prisma.design.findMany({
        where: { id: { in: hits.map((h) => h.designId) } },
        include: CATALOG_INCLUDE,
      });
      const byId = new Map(rows.map((r) => [r.id, r]));
      const designs = hits
        .map((hit) => {
          const d = byId.get(hit.designId);
          return d ? toCatalogItem(d, { distance: hit.distance, matchedField: hit.matchedField }) : null;
        })
        .filter((d): d is NonNullable<typeof d> => d !== null);
      return NextResponse.json({ designs, nextCursor: null });
    }

    const rows = await prisma.design.findMany({
      where: {
        OR: [
          { title: { contains: q, mode: "insensitive" } },
          { phrase: { contains: q, mode: "insensitive" } },
          { batch: { keyword: { contains: q, mode: "insensitive" } } },
        ],
      },
      include: CATALOG_INCLUDE,
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return NextResponse.json({
      designs: rows.map((d) => toCatalogItem(d, { distance: 0, matchedField: "exact" })),
      nextCursor: null,
    });
  }

  const cursor = decodeCursor(url.searchParams.get("cursor"));
  const rows = await prisma.design.findMany({
    where: { ...(status ? { status } : {}), ...cursorWhereClause(cursor) },
    include: CATALOG_INCLUDE,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return NextResponse.json({
    designs: page.map((d) => toCatalogItem(d)),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null,
  });
}
