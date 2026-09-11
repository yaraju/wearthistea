import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCustomer, getCustomerSession } from "@/lib/auth";
import { renderDesignArtwork, isTransientProviderError } from "@/lib/design-render";
import { checkGenerateRateLimit } from "@/lib/rate-limit";
import { enqueuePrintroveProducts } from "@/lib/tasks";
import { ensureDesignProduct } from "@/lib/design-products";
import { settings } from "@/config/settings";
import { langfuse, getTraceId } from "@/lib/langfuse";
import { logger } from "@/lib/logger";
import { friendlyError } from "@/lib/error-messages";

export const runtime = "nodejs";
export const maxDuration = 300;

// Regenerate a rejected order: spawns a fresh Design (re-rendered artwork)
// and a fresh Order carrying the same shipping/payment snapshot, left at
// "pending" for normal admin review. The rejected order itself is NEVER
// mutated — it stays as history, linked via the new order's
// regeneratedFromOrderId. See the plan doc for why this spawns rather than
// mutates in place (a paid prepaid order's payment state has to be carried
// forward carefully — see the paymentProvider/paymentStatus guard below).
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireCustomer(req);
  if (denied) return denied;
  const session = await getCustomerSession(req);

  const { id } = await ctx.params;

  const order = await prisma.order.findUnique({
    where: { id },
    include: { design: true },
  });

  // 404 for both "doesn't exist" and "not yours" — never confirm the
  // existence of another customer's order id.
  if (!order || order.userId !== session!.uid) {
    return NextResponse.json({ error: "Order not found." }, { status: 404 });
  }
  if (order.status !== "rejected") {
    return NextResponse.json({ error: "This order isn't eligible for regeneration." }, { status: 409 });
  }

  // Idempotent re-click: if this order was already regenerated, just return
  // the order it already spawned rather than creating a second one.
  const existingRegeneration = await prisma.order.findUnique({
    where: { regeneratedFromOrderId: order.id },
  });
  if (existingRegeneration) {
    return NextResponse.json({ ok: true, order: existingRegeneration });
  }

  // A prepaid order that was never actually paid shouldn't reach "rejected"
  // in practice (pushOrderToProvider refuses unpaid prepaid orders before
  // they'd ever get this far into review) — but refuse explicitly rather
  // than spawn an order pushOrderToProvider would also refuse.
  if (order.paymentProvider === "razorpay" && order.paymentStatus !== "paid") {
    return NextResponse.json(
      { error: "This order can't be regenerated automatically — contact support." },
      { status: 409 }
    );
  }

  // Same budget pool as /api/generate/retry — this triggers a real,
  // billed Gemini render.
  const rateLimit = await checkGenerateRateLimit(req);
  if (!rateLimit.ok) {
    return NextResponse.json(
      { error: "You've hit the free-generation limit for now — try again in a bit." },
      { status: 429 }
    );
  }

  const traceId = getTraceId(req);
  const trace = langfuse.trace({
    name: "account-regenerate",
    id: traceId,
    input: { orderId: order.id },
  });

  // Clone the Design row — NEVER re-render the original in place, since
  // other Orders may still reference it (Design.orders is one-to-many).
  // Deliberately does NOT copy:
  //  - printroveDesignId: that's the REJECTED artwork's Printrove upload
  //    id — carrying it forward would risk the new order printing the old,
  //    rejected art if renderDesignArtwork's re-render is ever skipped.
  //  - designImageData / image paths: stale until renderDesignArtwork runs.
  const design = order.design;
  const clonedDesign = await prisma.design.create({
    data: {
      batchId: design.batchId,
      title: design.title,
      phrase: design.phrase,
      visualConcept: design.visualConcept,
      vibe: design.vibe,
      blurb: design.blurb,
      backPhrase: design.backPhrase,
      backLayout: design.backLayout,
      style: design.style,
      designPrompt: design.designPrompt,
      productPrompt: design.productPrompt,
      category: design.category,
      variantColor: design.variantColor,
      productImagePath: "",
      designImagePath: "",
      status: "generating",
    },
  });

  let renderedDesign;
  try {
    renderedDesign = await renderDesignArtwork(clonedDesign, trace, rateLimit);
  } catch (err) {
    // renderDesignArtwork's own failure path doesn't persist a status —
    // that's this caller's job (retry route does the same for its design).
    const rawMessage = err instanceof Error ? err.message : "Regeneration failed.";
    await prisma.design
      .update({ where: { id: clonedDesign.id }, data: { status: "failed", errorMessage: rawMessage } })
      .catch((updateErr) => {
        logger.error("[account/orders/regenerate] Failed to persist failure status", {
          designId: clonedDesign.id,
          error: updateErr,
        });
      });
    const transient = isTransientProviderError(err);
    const message = transient
      ? "Our design engine is swamped right now — try again in a moment."
      : friendlyError(rawMessage);
    trace.update({ tags: ["error"], output: { error: rawMessage } });
    logger.error(`[account/orders/regenerate] Render failed for order ${order.id}: ${rawMessage}`, {
      traceId,
      orderId: order.id,
      error: err,
    });
    return NextResponse.json({ error: message }, { status: transient ? 503 : 500 });
  }

  // Best-effort — same as /api/generate/retry. Never fails the response;
  // the artwork already rendered, which is what the customer is waiting on.
  try {
    await enqueuePrintroveProducts(clonedDesign.id);
  } catch (err) {
    logger.error("[account/orders/regenerate] Failed to enqueue Printrove preview creation", {
      designId: clonedDesign.id,
      error: err,
    });
  }

  // Create (or reuse) the DesignProduct for this specific (design, category,
  // color) combo up front, same as /api/designs/select does — without this,
  // the new Order's designProductId would be null, and decideDesignProduct's
  // bulk-approve cascade (which queries pending Orders BY designProductId)
  // would silently skip it; it'd only ever clear the admin queue via an
  // individual approve click on this one order. ensureDesignProduct never
  // throws on a Printrove-side failure (returns a status:"failed" row
  // instead), so this can't abort an otherwise-successful regeneration.
  const designProduct =
    settings.provider === "printrove"
      ? await ensureDesignProduct(renderedDesign.id, order.productCategory)
      : null;

  const stillPaid = order.paymentProvider === "razorpay"; // only reachable path is already paymentStatus === "paid", per the guard above
  const newOrder = await prisma.order.create({
    data: {
      designId: renderedDesign.id,
      designProductId: designProduct?.id ?? null,
      userId: session!.uid,
      regeneratedFromOrderId: order.id,
      status: "pending",

      productCategory: order.productCategory,
      variantSize: order.variantSize,
      variantColor: order.variantColor,
      quantity: order.quantity,

      unitPriceCents: order.unitPriceCents,
      gstRateBps: order.gstRateBps,
      gstAmountCents: order.gstAmountCents,

      recipientName: order.recipientName,
      recipientEmail: order.recipientEmail,
      recipientPhone: order.recipientPhone,
      addressLine1: order.addressLine1,
      addressLine2: order.addressLine2,
      addressLine3: order.addressLine3,
      city: order.city,
      state: order.state,
      pincode: order.pincode,
      country: order.country,
      addressId: order.addressId,

      paymentProvider: order.paymentProvider,
      cod: order.cod,
      // Carried forward only when already paid — never copies
      // razorpayOrderId/razorpayPaymentId/idempotencyKey (all @unique on
      // Order — copying them would throw a constraint violation).
      paymentStatus: stillPaid ? "paid" : "unpaid",
    },
  });

  trace.update({ output: { newDesignId: renderedDesign.id, newOrderId: newOrder.id } });
  return NextResponse.json({ ok: true, order: newOrder });
}
