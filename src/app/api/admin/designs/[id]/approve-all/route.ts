import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { decideDesignProduct } from "@/lib/design-product-review";

export const runtime = "nodejs";
export const maxDuration = 300;

// Approve every currently-unreviewed (category, color) combo for one
// design in a single action — the time-saver for when everything shown in
// the review modal looks fine, vs. clicking Approve on each one.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const { id: designId } = await ctx.params;

  const unreviewed = await prisma.designProduct.findMany({
    where: { designId, approvalStatus: "unreviewed" },
  });

  const results = [];
  for (const row of unreviewed) {
    const result = await decideDesignProduct(row.id, "approved");
    results.push({ category: row.category, pushed: result.pushed, failed: result.failed });
  }

  return NextResponse.json({ ok: true, results });
}
