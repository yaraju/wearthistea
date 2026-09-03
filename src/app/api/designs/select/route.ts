import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { settings, printroveProduct } from "@/config/settings";
import { realizeDesign } from "@/lib/realize";
import { computeGst } from "@/lib/gst";

export const runtime = "nodejs";

const Customer = z.object({
  name: z.string().trim().min(1).max(120),
  // Mandatory (Phase 6): this is the email a magic-link sign-in is sent to
  // at checkout, and every order needs somewhere to send its GST invoice /
  // shipping updates — see src/lib/auth.ts.
  email: z.string().trim().email().max(160),
  phone: z.string().trim().min(5).max(20),
  address1: z.string().trim().min(1).max(200),
  address2: z.string().trim().max(200).optional().or(z.literal("")),
  city: z.string().trim().max(80).optional().or(z.literal("")),
  state: z.string().trim().max(80).optional().or(z.literal("")),
  pincode: z.string().trim().max(20).optional().or(z.literal("")),
  country: z.string().trim().min(1).max(80),
});

const Body = z.object({
  designId: z.string().min(1),
  size: z.string().trim().min(1).max(40),
  color: z.string().trim().min(1).max(40),
  quantity: z.number().int().min(1).max(10).default(1),
  customer: Customer.optional(),
  // "cod" (default): goes straight into the /admin approval queue, exactly
  // today's behavior. "prepaid": the order is created but held out of the
  // admin queue (status: pending_payment) until the customer completes
  // Razorpay Checkout — see /api/orders/create — so nothing gets fulfilled
  // (or shipped, or refund-owed) for money that hasn't actually arrived yet.
  paymentMethod: z.enum(["cod", "prepaid"]).default("cod"),
});

// User picks a design on the landing page + fills in the checkout → this
// creates a new Order for that design and puts it in the /admin approval
// queue (immediately for COD; after payment for prepaid). One Design can
// end up with many Orders (different buyers, or the same buyer retrying) —
// order/shipping state never lives on Design itself.
export async function POST(req: Request) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json(
      { error: "Please choose a size/color and fill in the required details." },
      { status: 400 }
    );
  }

  // Printrove places a real shipping order, so recipient details are required.
  if (settings.provider !== "printify" && !body.customer) {
    return NextResponse.json(
      { error: "Shipping details are required to place this order." },
      { status: 400 }
    );
  }

  const design = await prisma.design.findUnique({ where: { id: body.designId } });
  if (!design)
    return NextResponse.json({ error: "Design not found." }, { status: 404 });

  if (design.status === "failed")
    return NextResponse.json(
      { error: "This design failed to render — try regenerating." },
      { status: 409 }
    );

  // Reject a size/color that isn't actually sellable for this design's
  // category — the checkout form only ever offers valid combinations, but
  // this is the boundary where a stale or tampered client can't slip one
  // past us into an Order Printrove would then fail (or silently mis-sell).
  if (settings.provider === "printrove") {
    const product = printroveProduct(design.category);
    if (!product.variantMap[`${body.color}|${body.size}`]) {
      return NextResponse.json(
        { error: `"${body.size}" in "${body.color}" isn't offered for this design.` },
        { status: 400 }
      );
    }
  }

  // Realize (or re-realize) when: this is a legacy row that never got past
  // Stage 1 preview, or the buyer picked a different garment color at
  // checkout than the one the art was actually generated for — designImage()
  // picks ink color (light-on-dark vs dark-on-light) from the garment color,
  // so a color change can otherwise ship art that's invisible on the tee.
  const colorChanged = Boolean(design.variantColor) && design.variantColor !== body.color;
  if (design.status !== "generated" || colorChanged) {
    try {
      // variantColor is generation content (what the art was rendered
      // against), not order content — still updated here since the buyer's
      // color choice is what realizeDesign() needs to re-render correctly.
      await prisma.design.update({
        where: { id: body.designId },
        data: { variantColor: body.color },
      });
      // realizeDesign() catches its own errors and returns a status:"failed"
      // row rather than throwing — it never reaches the catch block below on
      // its own, so the failure has to be read from its return value.
      const realized = await realizeDesign(body.designId);
      if (realized.status === "failed") {
        return NextResponse.json(
          { error: realized.errorMessage || "Could not finalize the high-res design. Please try again." },
          { status: 500 }
        );
      }
    } catch (err) {
      console.error("[Realize] Failed during selection:", err);
      return NextResponse.json(
        { error: "Could not finalize the high-res design. Please try again." },
        { status: 500 }
      );
    }
  }

  const c = body.customer;
  const prepaid = body.paymentMethod === "prepaid";

  // Price the order now (not at approval time) — prepaid needs an amount to
  // charge before approval ever happens, and pricing it up front (instead of
  // whatever settings.printrove looks like whenever an admin eventually
  // clicks approve) is what the customer actually agreed to pay.
  const product = printroveProduct(design.category);
  const gst = computeGst(product.retailPrice, body.quantity, c?.state || null, settings.seller.state);

  const order = await prisma.order.create({
    data: {
      designId: body.designId,
      status: prepaid ? "pending_payment" : "pending",
      productCategory: design.category,
      variantSize: body.size,
      variantColor: body.color,
      quantity: body.quantity,
      unitPriceCents: product.retailPrice,
      gstRateBps: Math.round(gst.gstRate * 10000),
      gstAmountCents: Math.round(gst.gstAmount),
      paymentProvider: prepaid ? "razorpay" : "cod",
      paymentStatus: "unpaid",
      cod: prepaid ? false : settings.printrove.cod,
      recipientName: c?.name ?? null,
      recipientEmail: c?.email || null,
      recipientPhone: c?.phone ?? null,
      addressLine1: c?.address1 ?? null,
      addressLine2: c?.address2 || null,
      city: c?.city || null,
      state: c?.state || null,
      pincode: c?.pincode || null,
      country: c?.country ?? null,
    },
  });
  await prisma.batch.update({
    where: { id: design.batchId },
    data: { status: "queued" },
  });

  return NextResponse.json({ ok: true, order });
}
