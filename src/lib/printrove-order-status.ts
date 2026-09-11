import { prisma } from "@/lib/prisma";
import { getOrderStatus } from "@/lib/printrove";
import { mapPrintroveStatus, type LivePrintroveStatus } from "@/lib/printrove-status";
import { settings } from "@/config/settings";
import { logger } from "@/lib/logger";
import type { Order, OrderStatusCache } from "@prisma/client";

export type OrderWithCache = Order & { statusCache: OrderStatusCache | null };

export interface LiveStatusResult {
  statusSimplified: LivePrintroveStatus;
  trackingUrl: string | null;
  courierName: string | null;
  trackingNumber: string | null;
  /** Only set when THIS call caused the delivered transition — callers
   *  should merge it onto their in-memory order rather than re-querying. */
  deliveredAt: Date | null;
}

/**
 * Read-through cache: fetch Printrove's live order status on demand (called
 * from GET /api/account/orders when a customer opens the page — there is no
 * webhook). Returns the resolved status so callers can merge it into the
 * order they already have in memory; deliberately does NOT return anything
 * that requires a second `findMany` re-read (which would need to re-apply
 * `orderBy` itself — see the route).
 */
export async function refreshLiveStatus(order: OrderWithCache): Promise<LiveStatusResult | null> {
  // Terminal orders never change again — this is the main cost-control
  // lever, no Printrove call at all for anything already resolved.
  if (order.deliveredAt || !order.printroveOrderId || order.status !== "published") return null;

  const cache = order.statusCache;

  // Cancelled is also terminal (nothing further happens on Printrove's
  // side) — once cached, stop polling instead of re-fetching forever.
  if (cache?.statusSimplified === "cancelled") {
    return {
      statusSimplified: "cancelled",
      trackingUrl: cache.trackingUrl,
      courierName: cache.courierName,
      trackingNumber: order.trackingNumber,
      deliveredAt: null,
    };
  }

  const fresh =
    cache && Date.now() - cache.fetchedAt.getTime() < settings.printrove.orderStatusCacheTtlMs;
  if (fresh) {
    return {
      statusSimplified: (cache!.statusSimplified as LivePrintroveStatus) ?? "printing",
      trackingUrl: cache!.trackingUrl,
      courierName: cache!.courierName,
      trackingNumber: order.trackingNumber,
      deliveredAt: null,
    };
  }

  try {
    const live = await getOrderStatus(order.printroveOrderId);
    const simplified = mapPrintroveStatus(live.raw);
    // Prefer Printrove's own delivery timestamp when the response includes
    // one; otherwise fall back to this order's last-known updatedAt rather
    // than "now" — an order that was ALREADY delivered before this feature
    // shipped shouldn't get stamped as delivered today just because today
    // is the first time we checked, or it would wrongly show as "delivered
    // this week" for a full week. Confirm live.deliveredAt actually gets
    // populated once scripts/test-order-status.ts has run against a real
    // order — see printrove.ts#getOrderStatus.
    const deliveredAt = simplified === "delivered" ? live.deliveredAt ?? order.updatedAt : null;
    const trackingNumberChanged =
      live.trackingNumber != null && live.trackingNumber !== order.trackingNumber;

    await prisma.$transaction([
      prisma.orderStatusCache.upsert({
        where: { orderId: order.id },
        create: {
          orderId: order.id,
          statusRaw: live.raw,
          statusSimplified: simplified,
          trackingUrl: live.trackingUrl,
          courierName: live.courierName,
        },
        update: {
          statusRaw: live.raw,
          statusSimplified: simplified,
          trackingUrl: live.trackingUrl,
          courierName: live.courierName,
          fetchedAt: new Date(),
        },
      }),
      ...(deliveredAt || trackingNumberChanged
        ? [
            prisma.order.update({
              where: { id: order.id },
              data: {
                ...(deliveredAt ? { deliveredAt } : {}),
                ...(trackingNumberChanged ? { trackingNumber: live.trackingNumber } : {}),
              },
            }),
          ]
        : []),
    ]);

    return {
      statusSimplified: simplified,
      trackingUrl: live.trackingUrl,
      courierName: live.courierName,
      trackingNumber: live.trackingNumber ?? order.trackingNumber,
      deliveredAt,
    };
  } catch (err) {
    // Best-effort — serve the last-known cache (even stale) rather than a
    // blank status; a transient Printrove outage shouldn't break the page.
    logger.error("[printrove-order-status] live fetch failed", { orderId: order.id, error: err });
    if (cache) {
      return {
        statusSimplified: (cache.statusSimplified as LivePrintroveStatus) ?? "printing",
        trackingUrl: cache.trackingUrl,
        courierName: cache.courierName,
        trackingNumber: order.trackingNumber,
        deliveredAt: null,
      };
    }
    return null;
  }
}
