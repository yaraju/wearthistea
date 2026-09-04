import { NextResponse } from "next/server";
import { printroveProduct } from "@/config/settings";
import { ensureDesignProduct } from "@/lib/design-products";

export const runtime = "nodejs";
export const maxDuration = 60;

// Polled by the customer pick-time modal (and the admin review modal) —
// thin wrapper over ensureDesignProduct, which does the actual work and is
// idempotent: whichever caller gets here first (the brew-time task, or this
// endpoint) creates the row, the other just reads it back.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: designId } = await ctx.params;
  const category = new URL(req.url).searchParams.get("category");

  if (!category) {
    return NextResponse.json({ error: "category is required." }, { status: 400 });
  }
  const product = printroveProduct(category);
  if (!product.enabled || product.category !== category) {
    return NextResponse.json({ error: `"${category}" isn't an offered apparel type.` }, { status: 400 });
  }

  const row = await ensureDesignProduct(designId, category);

  return NextResponse.json({
    status: row.status,
    category: row.category,
    color: row.color,
    mockupFrontUrl: row.mockupFrontUrl,
    mockupBackUrl: row.mockupBackUrl,
    errorMessage: row.status === "failed" ? row.errorMessage : null,
    approvalStatus: row.approvalStatus,
  });
}
