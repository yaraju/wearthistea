import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyPaymentSignature } from "@/lib/razorpay";

export const runtime = "nodejs";

const Body = z.object({
  razorpay_order_id: z.string().min(1),
  razorpay_payment_id: z.string().min(1),
  razorpay_signature: z.string().min(1),
});

// Checkout's success handler calls this so the frontend can show "payment
// received" immediately. This is UX only — it verifies the signature and
// returns ok/not-ok, but never writes to the database. The webhook
// (/api/webhooks/razorpay) is the only thing that marks an Order paid: a
// client-side success callback can be skipped (closed tab, JS error) or, in
// principle, forged, so nothing here is trusted to authorize fulfillment.
export async function POST(req: Request) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Missing payment verification fields." }, { status: 400 });
  }

  try {
    const ok = verifyPaymentSignature({
      razorpayOrderId: body.razorpay_order_id,
      razorpayPaymentId: body.razorpay_payment_id,
      signature: body.razorpay_signature,
    });
    if (!ok) return NextResponse.json({ ok: false, error: "Signature mismatch." }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Verification failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
