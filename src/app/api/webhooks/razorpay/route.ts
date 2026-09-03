import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyWebhookSignature } from "@/lib/razorpay";
import { generateInvoice } from "@/lib/invoice";
import { enqueueEmail } from "@/lib/tasks";
import { orderConfirmationEmail } from "@/lib/email";
import { readImageAsBase64 } from "@/lib/storage";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

// Source of truth for "did this order actually get paid" — never the
// frontend's /api/orders/verify callback. Razorpay retries undelivered/
// non-200 webhooks, so every step here has to be safe to run twice: the
// paymentStatus check below skips the DB update on a re-delivery, and
// generateInvoice() is separately idempotent (returns the existing invoice
// instead of issuing a second one for the same order).
export async function POST(req: Request) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-razorpay-signature");

  if (!signature) {
    return NextResponse.json({ error: "Missing signature." }, { status: 400 });
  }

  let valid: boolean;
  try {
    valid = verifyWebhookSignature(rawBody, signature);
  } catch (err) {
    logger.error("[Razorpay webhook] Signature check failed to run", { error: err });
    return NextResponse.json({ error: "Signature verification unavailable." }, { status: 500 });
  }
  if (!valid) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  if (event.event !== "payment.captured") {
    // Not an event we act on — acknowledge so Razorpay doesn't retry it.
    return NextResponse.json({ ok: true, ignored: event.event });
  }

  const payment = event.payload?.payment?.entity;
  const razorpayOrderId: string | undefined = payment?.order_id;
  const razorpayPaymentId: string | undefined = payment?.id;
  if (!razorpayOrderId || !razorpayPaymentId) {
    logger.error("[Razorpay webhook] payment.captured missing order_id/payment id", { event });
    return NextResponse.json({ error: "Malformed payload." }, { status: 400 });
  }

  const order = await prisma.order.findFirst({
    where: { razorpayOrderId },
    include: { design: true },
  });
  if (!order) {
    // Could be an order placed before this webhook was configured, or a
    // stray test event — nothing to do, but acknowledge so it isn't retried.
    logger.error("[Razorpay webhook] No Order for razorpayOrderId", { razorpayOrderId });
    return NextResponse.json({ ok: true, unmatched: razorpayOrderId });
  }

  if (order.paymentStatus !== "paid") {
    await prisma.order.update({
      where: { id: order.id },
      data: {
        paymentStatus: "paid",
        razorpayPaymentId,
        // Same "awaiting admin approval" bucket a COD order lands in —
        // approval is still a manual art-QC step for now, just gated on
        // payment instead of always-COD.
        status: "pending",
      },
    });
  }

  // invoiceNumber already set means a prior delivery already generated and
  // (attempted to) email the invoice — don't re-send on a Razorpay retry.
  const alreadyInvoiced = Boolean(order.invoiceNumber);
  let invoiceUrl: string | null = order.invoiceUrl;
  try {
    const result = await generateInvoice(order.id);
    invoiceUrl = result.invoiceUrl;
  } catch (err) {
    // Payment is already recorded as paid above — don't fail the webhook
    // (and trigger a Razorpay retry loop) over invoice generation; log it
    // for manual follow-up instead. It can be regenerated via
    // scripts/test-invoice.ts once the underlying issue is fixed.
    logger.error("[Razorpay webhook] Invoice generation failed", { orderId: order.id, error: err });
  }

  if (!alreadyInvoiced && order.recipientEmail && order.recipientName) {
    try {
      const attachments = invoiceUrl
        ? [{ filename: `${order.invoiceNumber ?? "invoice"}.pdf`, contentBase64: await readImageAsBase64(invoiceUrl) }]
        : undefined;
      await enqueueEmail({
        to: order.recipientEmail,
        ...orderConfirmationEmail({
          recipientName: order.recipientName,
          designTitle: order.design.title,
          variantSize: order.variantSize,
          variantColor: order.variantColor,
          quantity: order.quantity,
          totalRupees: (order.unitPriceCents ?? 0) * order.quantity,
          invoiceNumber: order.invoiceNumber,
        }),
        attachments,
      });
    } catch (err) {
      logger.error("[Razorpay webhook] Order confirmation email failed to enqueue", { orderId: order.id, error: err });
    }
  }

  return NextResponse.json({ ok: true });
}
