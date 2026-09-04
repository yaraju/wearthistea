import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { decideDesignProduct } from "@/lib/design-product-review";

export const runtime = "nodejs";
export const maxDuration = 120;

const Body = z.object({
  decision: z.enum(["approved", "rejected"]),
  note: z.string().trim().max(500).optional(),
});

// Approve or reject one (design, category, color) combo. Approving
// immediately flushes any currently-pending Orders for it through
// fulfillment; rejecting marks them rejected instead.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const { id } = await ctx.params;
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "decision is required." }, { status: 400 });
  }

  try {
    const result = await decideDesignProduct(id, body.decision, body.note);
    return NextResponse.json({ ok: true, ...result });
  } catch {
    return NextResponse.json({ error: "Could not save this decision." }, { status: 500 });
  }
}
