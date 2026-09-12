import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCustomer, getCustomerSession } from "@/lib/auth";
import { getDesignEmbeddings, searchDesignsByVectors } from "@/lib/design-search";
import { toDesignMatchDTOs } from "@/lib/design-match-dto";

export const runtime = "nodejs";

/**
 * "Similar to my brew" — semantic match against the design's own stored
 * embeddings (no re-embedding). Ownership-checked: a customer can only look
 * up similar designs starting from a design they themselves brewed.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireCustomer(req);
  if (denied) return denied;
  const session = await getCustomerSession(req);
  const { id: designId } = await ctx.params;

  const design = await prisma.design.findUnique({ where: { id: designId }, select: { createdByUserId: true } });
  if (!design || design.createdByUserId !== session!.uid) {
    return NextResponse.json({ error: "Design not found." }, { status: 404 });
  }

  const vectors = await getDesignEmbeddings(designId);
  if (!vectors) return NextResponse.json({ matches: [] });

  const hits = await searchDesignsByVectors(vectors, {
    limit: 8,
    onlyStatus: "generated",
    excludeAllRejected: true,
    excludeDesignIds: [designId],
  });

  return NextResponse.json({ matches: await toDesignMatchDTOs(hits) });
}
