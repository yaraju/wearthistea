import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getRazorpayClient } from "@/lib/razorpay";

export const runtime = "nodejs";

const Body = z.object({ orderId: z.string().min(1) });

// Attaches a Razorpay order to an Order that /api/designs/select already
// created with paymentMethod "prepaid" (status: pending_payment). Does NOT
// create the Order itself — that already happened, with the price already
// locked in, so there's exactly one place an Order comes into existence and
// no chance of a second one drifting out of sync with it.
export async function POST(req: Request) {
  let orderId: string;
  try {
    orderId = Body.parse(await req.json()).orderId;
  } catch {
    return NextResponse.json({ error: "orderId is required." }, { status: 400 });
  }

  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) return NextResponse.json({ error: "Order not found." }, { status: 404 });

  if (order.paymentStatus === "paid")
    return NextResponse.json({ error: "This order is already paid." }, { status: 409 });
  if (order.status !== "pending_payment")
    return NextResponse.json({ error: "This order isn't awaiting payment." }, { status: 409 });
  if (!order.unitPriceCents)
    return NextResponse.json({ error: "This order has no price set." }, { status: 409 });

  // Reuse an already-created Razorpay order rather than minting a new one on
  // every retry/page-reload — Razorpay orders aren't cheap to abandon in
  // bulk, and this keeps razorpayOrderId meaning "the one true order" for
  // the idempotency guard in the webhook handler.
  if (order.razorpayOrderId) {
    return NextResponse.json({
      razorpayOrderId: order.razorpayOrderId,
      amountPaise: Math.round(order.unitPriceCents * order.quantity * 100),
      currency: "INR",
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  }

  // order.unitPriceCents is a plain rupee amount (see the comment in
  // printrove.ts's createOrder) — Razorpay's Orders API wants the amount in
  // paise, the smallest currency unit, so this *100 is a real unit
  // conversion, not just renaming.
  const amountPaise = Math.round(order.unitPriceCents * order.quantity * 100);

  try {
    const razorpay = getRazorpayClient();
    const rzpOrder = await razorpay.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt: order.id,
      notes: { orderId: order.id, designId: order.designId },
    });

    await prisma.order.update({
      where: { id: orderId },
      data: { razorpayOrderId: rzpOrder.id },
    });

    return NextResponse.json({
      razorpayOrderId: rzpOrder.id,
      amountPaise,
      currency: "INR",
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not start payment.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
