import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { designSlug } from "@/lib/slug";

export const runtime = "nodejs";

/**
 * Admin-only "regenerate": creates a brand-new sibling Design row from the
 * same concept/prompt text, rather than re-rendering the original in place —
 * keeps the original intact for side-by-side before/after comparison in the
 * catalog. Does NOT render art synchronously (that would reintroduce the
 * ~60s Firebase Hosting proxy timeout /api/generate's two-stage split exists
 * to avoid) — the admin client calls the existing POST /api/generate/retry
 * against the returned design's id to actually trigger rendering, reusing
 * the same proven, timeout-safe path a fresh brew already uses.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;

  const source = await prisma.design.findUnique({ where: { id } });
  if (!source) {
    return NextResponse.json({ error: "Design not found." }, { status: 404 });
  }

  let sibling;
  try {
    sibling = await prisma.design.create({
      data: {
        batchId: source.batchId,
        title: source.title,
        phrase: source.phrase,
        visualConcept: source.visualConcept,
        vibe: source.vibe,
        blurb: source.blurb,
        backPhrase: source.backPhrase,
        backLayout: source.backLayout,
        style: source.style,
        designPrompt: source.designPrompt,
        productPrompt: source.productPrompt,
        category: source.category,
        variantColor: source.variantColor,
        // Fresh render + fresh approval cycle — never carry over the source's
        // Printrove asset ids (they point at ITS art) or any DesignProduct
        // rows (a sibling regenerate is meant to be independently reviewable).
        designImagePath: "",
        productImagePath: "",
        designPreviewImagePath: "",
        productPreviewImagePath: "",
        status: "generating",
        // Record lineage back to the source design — mirrors
        // Order.regeneratedFromOrderId. Populated here (not just by the
        // bulk-judge regeneration path) so lineage is consistent everywhere a
        // sibling Design is spawned.
        regeneratedFromDesignId: source.id,
      },
    });
  } catch (err) {
    // regeneratedFromDesignId is @unique (at most one regeneration per
    // source design, same as Order.regeneratedFromOrderId) — a second
    // "regenerate" click against the same source design now hits that
    // constraint instead of silently creating another sibling. Surface it
    // as a clear 409 rather than a bare 500.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await prisma.design.findUnique({ where: { regeneratedFromDesignId: source.id } });
      return NextResponse.json(
        {
          error: "This design has already been regenerated once.",
          existingDesignId: existing?.id ?? null,
        },
        { status: 409 },
      );
    }
    throw err;
  }

  const slug = designSlug(sibling.title, sibling.id);
  // Concept text is unchanged from the source, so its embeddings are still
  // correct for the sibling — copy them directly via raw SQL rather than
  // spending a new Gemini call. Best-effort: never blocks the response.
  await prisma.$executeRaw`
    UPDATE "Design" AS target
    SET slug = ${slug},
        "keywordEmbedding" = source."keywordEmbedding",
        "conceptEmbedding" = source."conceptEmbedding",
        "backPhraseEmbedding" = source."backPhraseEmbedding"
    FROM "Design" AS source
    WHERE target.id = ${sibling.id} AND source.id = ${source.id}
  `.catch((err) => {
    console.error("[regenerate] Failed to copy slug/embeddings onto sibling (non-fatal):", err);
  });

  return NextResponse.json({ design: { ...sibling, slug } });
}
