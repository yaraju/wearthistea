import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveLatestDesignVersion } from "@/lib/design-versions";

export const runtime = "nodejs";

/**
 * Public lookup for a design's shareable page (/design/[slug]) and for
 * KeywordStudio's prebrewed-match detail fetch (see
 * `fetch(/api/designs/${match.slug || match.id})` in KeywordStudio.tsx).
 * Resolves a slug first; falls back to a bare id lookup so admin deep-links
 * using raw ids (e.g. from the catalog) still work.
 *
 * Always resolves to the current-best version (issue #20) — this is a
 * public/customer-facing single-design view, never an order-linked one, so
 * a superseded design here always hands back its terminal sibling's art
 * instead. 404s if nothing renderable is found — a "generating"/"failed"
 * design has nothing shareable to show.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  // Named `id` to match the sibling /api/designs/[id]/product route — Next.js
  // requires every dynamic segment at this path level to share one param
  // name — but the value is treated as "slug or id" (see below).
  const { id: slugOrId } = await ctx.params;

  const requested =
    (await prisma.design.findUnique({ where: { slug: slugOrId } })) ??
    (await prisma.design.findUnique({ where: { id: slugOrId } }));
  if (!requested) {
    return NextResponse.json({ error: "Design not found." }, { status: 404 });
  }

  const latest = await resolveLatestDesignVersion(requested);
  const design = latest.status === "generated" ? latest : requested;
  if (design.status !== "generated") {
    return NextResponse.json({ error: "Design not found." }, { status: 404 });
  }

  // Never send the full-res print file to a public caller — only previews.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { designImagePath, productImagePath, designImageData, backDesignImagePath, ...safeDesign } = design;

  return NextResponse.json({ design: safeDesign });
}
