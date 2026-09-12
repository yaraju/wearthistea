import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { searchDesignsByText, type EmbeddingField } from "@/lib/design-search";

export const runtime = "nodejs";

/**
 * STABLE, DOCUMENTED CONTRACT — this endpoint exists specifically so an
 * LLM-as-judge or a manual quality-review process can look up generated
 * designs by prompt/concept/back-phrase meaning and score them, independent
 * of the human-facing admin catalog UI. Do not change this response shape
 * casually; anything scripted against it (see scripts/test-design-search.ts)
 * depends on the field names below staying put.
 *
 * Semantic-only, unfiltered by design: no status/approval filtering, since
 * a judge needs to see failed/rejected designs too, not just what a
 * shopper would ever see.
 *
 *   GET /api/admin/designs/search?q=<text>&fields=keyword,concept,backPhrase&limit=20
 *   -> { query, results: [{ designId, slug, score, distance, matchedField,
 *                            title, phrase, visualConcept, backPhrase, keyword }] }
 *   score = 1 - distance (cosine similarity, higher is better).
 */
export async function GET(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim();
  if (!q) {
    return NextResponse.json({ error: "q is required." }, { status: 400 });
  }
  const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 100);
  const fieldsParam = url.searchParams.get("fields");
  const fields = fieldsParam
    ? (fieldsParam.split(",").filter((f) => ["keyword", "concept", "backPhrase"].includes(f)) as EmbeddingField[])
    : undefined;

  const hits = await searchDesignsByText(q, { limit, fields });
  if (hits.length === 0) {
    return NextResponse.json({ query: q, results: [] });
  }

  const rows = await prisma.design.findMany({
    where: { id: { in: hits.map((h) => h.designId) } },
    include: { batch: { select: { keyword: true } } },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));

  const results = hits
    .map((hit) => {
      const d = byId.get(hit.designId);
      if (!d) return null;
      return {
        designId: d.id,
        slug: d.slug,
        score: 1 - hit.distance,
        distance: hit.distance,
        matchedField: hit.matchedField,
        title: d.title,
        phrase: d.phrase,
        visualConcept: d.visualConcept,
        backPhrase: d.backPhrase,
        keyword: d.batch.keyword,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  return NextResponse.json({ query: q, results });
}
