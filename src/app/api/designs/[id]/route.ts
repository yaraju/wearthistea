import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/**
 * Public lookup for a design's shareable page (/design/[slug]). Resolves a
 * slug first; falls back to a bare id lookup so admin deep-links using raw
 * ids (e.g. from the catalog) still work. 404s if missing or not yet
 * rendered — a "generating"/"failed" design has nothing shareable to show.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  // Named `id` to match the sibling /api/designs/[id]/product route — Next.js
  // requires every dynamic segment at this path level to share one param
  // name — but the value is treated as "slug or id" (see below).
  const { id: slugOrId } = await ctx.params;

  const design =
    (await prisma.design.findUnique({ where: { slug: slugOrId } })) ??
    (await prisma.design.findUnique({ where: { id: slugOrId } }));

  if (!design || design.status !== "generated") {
    return NextResponse.json({ error: "Design not found." }, { status: 404 });
  }

  // Never send the full-res print file to a public caller — only previews.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { designImagePath, productImagePath, designImageData, backDesignImagePath, ...safeDesign } = design;

  return NextResponse.json({ design: safeDesign });
}
