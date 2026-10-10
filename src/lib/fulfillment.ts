import { prisma } from "@/lib/prisma";
import { getProvider } from "@/lib/print-provider";
import { readImageAsBase64 } from "@/lib/storage";
import { settings, printroveProduct } from "@/config/settings";
import { enqueueEmail } from "@/lib/tasks";
import { shippedEmail } from "@/lib/email";
import { logger } from "@/lib/logger";
import { isUploadReusable } from "@/lib/art-version";
import type { Order } from "@prisma/client";

export type PushOrderResult =
  | { ok: true; order: Order }
  | { ok: false; error: string; status: number };

/**
 * Push one approved Order to the active fulfillment provider — upload the
 * design (or reuse Design.printroveDesignId if brew time already uploaded
 * it) → create a product for the ORDER'S ACTUAL size/color → place a (COD)
 * order. Extracted from what was inline in /api/admin/approve so it can be
 * called from three places: that manual admin click, the approve/
 * approve-all cascade (flushing Orders that were already pending when a
 * DesignProduct gets approved), and select-time auto-fulfill for an
 * already-approved combo.
 *
 * In every case this resolves the variant from order.variantSize/
 * variantColor and calls createProduct for THAT size — it never reuses a
 * cached preview DesignProduct's printroveProductId (built at a fixed
 * previewSize), which would risk shipping the wrong size. Only the upload
 * (printroveDesignId) is ever shared.
 */
export async function pushOrderToProvider(orderId: string): Promise<PushOrderResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { design: true },
  });
  if (!order) return { ok: false, error: "Order not found.", status: 404 };

  // Already pushed — don't place a second Printrove order for the same
  // Order (a double-click, a retried request, or a second cascade call
  // shouldn't double-charge the wallet or double-ship).
  if (order.printroveOrderId || order.status === "published") {
    return { ok: true, order };
  }

  // A prepaid order that hasn't actually been paid yet has nothing to ship
  // for — COD orders skip this check since nothing is ever "paid" on our
  // side for them. This also means calling this on every pending order for
  // a newly-approved combo is safe even for unpaid prepaid ones: they just
  // no-op here rather than needing to be filtered out by the caller.
  if (order.paymentProvider === "razorpay" && order.paymentStatus !== "paid") {
    return { ok: false, error: "This order hasn't been paid yet — nothing to approve.", status: 409 };
  }

  const design = order.design;
  const printPath = design.designImagePath || design.productImagePath;
  if (!printPath) {
    return { ok: false, error: "This design has no artwork file to print.", status: 409 };
  }

  const provider = getProvider();

  if (provider.name !== "printify") {
    if (!order.recipientName || !order.addressLine1 || !order.country) {
      return { ok: false, error: "This order has no shipping details — it can't be placed.", status: 409 };
    }
    if (!order.variantSize || !order.variantColor) {
      return { ok: false, error: "This order has no size/color selected.", status: 409 };
    }
  }

  // Prefer the price already locked in at order-creation time (what the
  // customer actually agreed to / was charged) over recomputing from
  // current settings, which may have changed since.
  const priceCents =
    order.unitPriceCents ??
    (provider.name === "printify"
      ? settings.printify.priceCents
      : printroveProduct(order.productCategory).retailPrice);

  try {
    let designBase64: string;
    try {
      designBase64 = await readImageAsBase64(printPath);
    } catch {
      // File missing (e.g. ephemeral filesystem after a redeploy). Fall
      // back to the base64 copy stored in the database.
      if (!design.designImageData) {
        throw new Error(
          "Artwork file is missing and no database copy exists. Re-generate this design."
        );
      }
      designBase64 = design.designImageData;
    }
    const description =
      design.blurb ?? `${design.phrase} — an original wearthistea drop. ${design.visualConcept}`;

    // Back print (cheeky text + QR) — best-effort, same reasoning as the
    // front-art fallback above: a missing/unreadable back file shouldn't
    // block a real order from shipping front-only.
    let backDesignBase64: string | null = null;
    if (design.backDesignImagePath) {
      try {
        backDesignBase64 = await readImageAsBase64(design.backDesignImagePath);
      } catch {
        logger.error("[fulfillment] Back design file missing, shipping front-only", { orderId });
      }
    }

    const result = await provider.fulfill({
      referenceNumber: order.id,
      title: design.title,
      description,
      designBase64,
      designFileName: `${design.id}.png`,
      priceCents,
      quantity: order.quantity ?? 1,
      variant: {
        size: order.variantSize ?? "",
        color: order.variantColor ?? "",
      },
      category: order.productCategory,
      printroveDesignId: isUploadReusable(design.printroveDesignId, design.printroveDesignArtPath, design.designImagePath)
        ? design.printroveDesignId
        : null,
      ...(backDesignBase64
        ? {
            backDesignBase64,
            backDesignFileName: `${design.id}-back.png`,
            printroveBackDesignId: isUploadReusable(
              design.printroveBackDesignId,
              design.printroveBackDesignArtPath,
              design.backDesignImagePath
            )
              ? design.printroveBackDesignId
              : null,
            backLayout: design.backLayout,
          }
        : {}),
      customer: order.recipientName
        ? {
            name: order.recipientName,
            email: order.recipientEmail,
            phone: order.recipientPhone ?? "",
            address1: order.addressLine1 ?? "",
            address2: order.addressLine2,
            address3: order.addressLine3,
            city: order.city,
            state: order.state,
            pincode: order.pincode,
            country: order.country ?? "",
          }
        : null,
      cod: order.cod,
    });

    // Backfill the upload id onto Design if this was the first time it got
    // uploaded (e.g. a legacy order whose brew never ran the Printrove
    // task) — every later category/color/order for this design can then
    // reuse it instead of re-uploading.
    if (
      result.printroveDesignId &&
      !isUploadReusable(design.printroveDesignId, design.printroveDesignArtPath, design.designImagePath)
    ) {
      await prisma.design.update({
        where: { id: design.id },
        data: { printroveDesignId: result.printroveDesignId, printroveDesignArtPath: design.designImagePath },
      });
    }
    if (
      result.printroveBackDesignId &&
      !isUploadReusable(design.printroveBackDesignId, design.printroveBackDesignArtPath, design.backDesignImagePath)
    ) {
      await prisma.design.update({
        where: { id: design.id },
        data: {
          printroveBackDesignId: result.printroveBackDesignId,
          printroveBackDesignArtPath: design.backDesignImagePath,
        },
      });
    }

    const updated = await prisma.order.update({
      where: { id: orderId },
      data: {
        status: "published",
        unitPriceCents: priceCents,
        printroveProductId: result.productId,
        printroveUrl: result.url,
        printroveOrderId: result.orderId,
        trackingNumber: result.trackingNumber,
        errorMessage: null,
      },
    });

    if (result.trackingNumber && order.recipientEmail && order.recipientName) {
      try {
        await enqueueEmail({
          to: order.recipientEmail,
          ...shippedEmail({
            recipientName: order.recipientName,
            designTitle: design.title,
            trackingNumber: result.trackingNumber,
          }),
        });
      } catch (err) {
        logger.error("[fulfillment] Shipped email failed to enqueue", { orderId, error: err });
      }
    }

    return { ok: true, order: updated };
  } catch (err) {
    const message = err instanceof Error ? err.message : `${provider.name} push failed.`;
    await prisma.order.update({
      where: { id: orderId },
      data: { status: "failed", errorMessage: message },
    });
    return { ok: false, error: message, status: 502 };
  }
}
