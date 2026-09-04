import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { pushOrderToProvider } from "@/lib/fulfillment";

export const runtime = "nodejs";
export const maxDuration = 120;

const Body = z.object({ orderId: z.string().min(1) });

// Human approval → push to the active provider. The actual work (upload →
// create product → place order, error handling, shipped-email enqueue)
// lives in pushOrderToProvider (src/lib/fulfillment.ts) so it can also be
// called from the approve/approve-all cascade and select-time auto-fulfill.
export async function POST(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  let orderId: string;
  try {
    orderId = Body.parse(await req.json()).orderId;
  } catch {
    return NextResponse.json({ error: "orderId is required." }, { status: 400 });
  }

  const result = await pushOrderToProvider(orderId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, order: result.order });
}
