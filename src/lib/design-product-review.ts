import { prisma } from "@/lib/prisma";
import { pushOrderToProvider } from "@/lib/fulfillment";
import { logger } from "@/lib/logger";
import type { DesignProduct } from "@prisma/client";

export interface ReviewResult {
  designProduct: DesignProduct;
  pushed: number;
  failed: number;
}

/**
 * Admin decision on one (design, category, color) combo — the content-
 * moderation gate DesignProduct.approvalStatus implements (see its schema
 * doc comment). On "approved", flushes every currently-pending Order for
 * this exact combo through pushOrderToProvider — multiple buyers may have
 * queued up in different sizes before an admin got to this. On "rejected",
 * marks those same pending Orders rejected instead; any future order
 * attempt for this combo is refused at /api/designs/select.
 *
 * pushOrderToProvider already no-ops safely on an unpaid prepaid order
 * (returns an error result rather than fulfilling), so pending_payment
 * orders can be included here without special-casing them out.
 */
export async function decideDesignProduct(
  designProductId: string,
  decision: "approved" | "rejected",
  note?: string
): Promise<ReviewResult> {
  const designProduct = await prisma.designProduct.update({
    where: { id: designProductId },
    data: { approvalStatus: decision, reviewedAt: new Date(), reviewNote: note ?? null },
  });

  const pendingOrders = await prisma.order.findMany({
    where: { designProductId, status: { in: ["pending", "pending_payment"] } },
  });

  let pushed = 0;
  let failed = 0;

  if (decision === "approved") {
    for (const order of pendingOrders) {
      const result = await pushOrderToProvider(order.id).catch((err) => {
        logger.error("[design-product-review] Cascade push failed", { orderId: order.id, error: err });
        return null;
      });
      if (result?.ok) pushed++;
      else failed++;
    }
  } else if (pendingOrders.length > 0) {
    await prisma.order.updateMany({
      where: { id: { in: pendingOrders.map((o) => o.id) } },
      data: {
        status: "rejected",
        errorMessage: "This design wasn't approved for this apparel type.",
      },
    });
  }

  return { designProduct, pushed, failed };
}
