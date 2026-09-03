import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getRazorpayClient } from "@/lib/razorpay";
import { enqueueEmail } from "@/lib/tasks";
import { refundProcessedEmail } from "@/lib/email";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

const Body = z.object({ orderId: z.string().min(1), reason: z.string().max(300).optional() });

// COD never needed this — nothing was ever collected up front. Prepaid
// introduces a failure mode COD didn't have: payment succeeds, then
// fulfillment fails (QC rejection, a Printrove error) — money has already
// moved, so it has to be given back explicitly rather than just marking the
// order failed and walking away.
export async function POST(req: Request) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "orderId is required." }, { status: 400 });
  }

  const order = await prisma.order.findUnique({
    where: { id: body.orderId },
    include: { design: true },
  });
  if (!order) return NextResponse.json({ error: "Order not found." }, { status: 404 });

  if (order.paymentProvider !== "razorpay" || !order.razorpayPaymentId) {
    return NextResponse.json(
      { error: "This order wasn't paid via Razorpay — nothing to refund here." },
      { status: 409 }
    );
  }
  if (order.paymentStatus === "refunded") {
    return NextResponse.json({ error: "Already refunded." }, { status: 409 });
  }

  try {
    const razorpay = getRazorpayClient();
    // No `amount` → full refund of whatever was captured.
    await razorpay.payments.refund(order.razorpayPaymentId, {
      notes: { orderId: order.id, reason: body.reason ?? "Order cancelled" },
    });

    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        paymentStatus: "refunded",
        status: "cancelled",
        errorMessage: body.reason ?? order.errorMessage,
      },
    });

    if (order.recipientEmail && order.recipientName) {
      try {
        await enqueueEmail({
          to: order.recipientEmail,
          ...refundProcessedEmail({
            recipientName: order.recipientName,
            designTitle: order.design.title,
            amountRupees: (order.unitPriceCents ?? 0) * order.quantity,
            reason: body.reason,
          }),
        });
      } catch (err) {
        logger.error("[refund] Refund email failed to enqueue", { orderId: order.id, error: err });
      }
    }

    return NextResponse.json({ ok: true, order: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Refund failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
