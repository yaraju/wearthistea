import type { LivePrintroveStatus } from "@/lib/printrove-status";

export type SimplifiedOrderStatus =
  | "in_review"
  | "printing"
  | "dispatched"
  | "out_for_delivery"
  | "delivered"
  | "rejected"
  | "failed"
  | "cancelled";

export type OrderBucket = "active" | "past" | "hidden";

export interface ResolvedOrderStatus {
  simplified: SimplifiedOrderStatus;
  bucket: OrderBucket;
}

interface OrderStatusInput {
  status: string;
  paymentStatus: string;
  deliveredAt: Date | null;
  /** The order's currently-known live-fetched status (from this request's
   *  refreshLiveStatus call, or the last cached value) — "printing" (the
   *  safe default) when nothing has been fetched yet. */
  liveSimplified?: LivePrintroveStatus | null;
}

// Trailing 7 days from `now`, not calendar-week — isolated here so it's a
// one-line change if the product definition of "this week" changes later.
const DELIVERED_ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
function isDeliveredThisWeek(deliveredAt: Date, now: Date): boolean {
  return now.getTime() - deliveredAt.getTime() <= DELIVERED_ACTIVE_WINDOW_MS;
}

/**
 * Maps an Order's DB lifecycle status (+ live Printrove status, when we
 * have one) to the 5 simplified customer-facing states and an Active/Past/
 * hidden bucket for /account/orders. This is the only place that logic
 * lives — the API route and OrderCard both just read the result.
 */
export function resolveOrderStatus(
  order: OrderStatusInput,
  now: Date = new Date()
): ResolvedOrderStatus {
  if (order.status === "rejected") return { simplified: "rejected", bucket: "past" };
  if (order.status === "failed") return { simplified: "failed", bucket: "past" };
  if (order.status === "cancelled") return { simplified: "cancelled", bucket: "past" };

  if (order.status === "pending_payment") {
    // Abandoned Razorpay checkout, never actually placed — hide rather than
    // show "in review", which would wrongly imply we're already on it. A
    // paid-but-not-yet-admin-reviewed order lands in "pending" instead (the
    // cascade in design-product-review.ts flips it there once paid).
    return { simplified: "in_review", bucket: "hidden" };
  }

  if (order.status === "pending") return { simplified: "in_review", bucket: "active" };

  if (order.status === "published") {
    // A merchant/customer-side cancellation on Printrove after we already
    // pushed the order — this is a live signal, not one of our own DB
    // lifecycle states, so it's checked here rather than added as another
    // top-level `order.status` branch.
    if (order.liveSimplified === "cancelled") return { simplified: "cancelled", bucket: "past" };
    if (order.deliveredAt) {
      return {
        simplified: "delivered",
        bucket: isDeliveredThisWeek(order.deliveredAt, now) ? "active" : "past",
      };
    }
    return { simplified: order.liveSimplified ?? "printing", bucket: "active" };
  }

  // Any future/unrecognized Order.status value not handled above must land
  // in Past, never silently join Active — extend the branches above
  // explicitly if a new status is ever introduced.
  return { simplified: "failed", bucket: "past" };
}
