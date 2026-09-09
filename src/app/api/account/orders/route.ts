import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCustomer, getCustomerSession } from "@/lib/auth";
import { refreshLiveStatus } from "@/lib/printrove-order-status";
import { resolveOrderStatus } from "@/lib/order-status";
import type { LivePrintroveStatus } from "@/lib/printrove-status";

export const runtime = "nodejs";

// A signed-in customer's own order history — GET /api/account/orders,
// split into { active, past } (see order-status.ts for the bucketing
// rules). There is no Printrove webhook: this route IS the trigger for a
// live-status refresh, on a short read-through TTL cache (see
// printrove-order-status.ts) — nothing else calls Printrove for status.
export async function GET(req: Request) {
  const denied = await requireCustomer(req);
  if (denied) return denied;
  const session = await getCustomerSession(req);

  const orders = await prisma.order.findMany({
    where: { userId: session!.uid },
    orderBy: { createdAt: "desc" },
    include: {
      design: {
        select: {
          title: true,
          phrase: true,
          vibe: true,
          productImagePath: true,
          designImagePath: true,
          designImageData: true,
        },
      },
      designProduct: { select: { mockupFrontUrl: true } },
      statusCache: true,
    },
  });

  // A regenerate click always keeps userId the same, so both a rejected
  // order and the fresh order it spawned are already in this same result
  // set — this avoids a second query/include just to check whether a
  // rejected order has already been regenerated once.
  const regeneratedFromIds = new Set(
    orders.filter((o) => o.regeneratedFromOrderId).map((o) => o.regeneratedFromOrderId as string)
  );

  // Fetch live status for every eligible order in parallel — a signed-in
  // customer's order count is realistically small, no concurrency cap
  // needed. refreshLiveStatus returns the fresh values directly so they can
  // be merged in memory below, rather than re-querying (which would need
  // to re-apply `orderBy` itself).
  const liveResults = await Promise.all(orders.map((o) => refreshLiveStatus(o)));

  const active: Record<string, unknown>[] = [];
  const past: Record<string, unknown>[] = [];

  orders.forEach((order, i) => {
    const live = liveResults[i];
    const effectiveDeliveredAt = live?.deliveredAt ?? order.deliveredAt;
    const cachedSimplified = order.statusCache?.statusSimplified as LivePrintroveStatus | null;
    const resolved = resolveOrderStatus({
      status: order.status,
      paymentStatus: order.paymentStatus,
      deliveredAt: effectiveDeliveredAt,
      liveSimplified: live?.statusSimplified ?? cachedSimplified,
    });
    if (resolved.bucket === "hidden") return;

    const isRejected = order.status === "rejected";
    const { design, designProduct, statusCache, ...o } = order;

    const dto = {
      ...o,
      title: design.title,
      phrase: design.phrase,
      vibe: design.vibe,
      // Strip design imagery server-side for rejected orders (not just
      // hidden client-side) — no flash of the design before JS hides it.
      productImagePath: isRejected ? null : design.productImagePath,
      designImagePath: isRejected ? null : design.designImagePath,
      hasImageData: isRejected ? false : Boolean(design.designImageData),
      printroveMockupUrl: isRejected ? null : (designProduct?.mockupFrontUrl ?? null),
      trackingNumber: live?.trackingNumber ?? order.trackingNumber,
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
      simplifiedStatus: resolved.simplified,
      trackingUrl: live?.trackingUrl ?? statusCache?.trackingUrl ?? null,
      courierName: live?.courierName ?? statusCache?.courierName ?? null,
      deliveredAt: effectiveDeliveredAt ? effectiveDeliveredAt.toISOString() : null,
      canRegenerate: isRejected && !regeneratedFromIds.has(order.id),
      regeneratedIntoOrderId:
        orders.find((x) => x.regeneratedFromOrderId === order.id)?.id ?? null,
    };

    (resolved.bucket === "active" ? active : past).push(dto);
  });

  return NextResponse.json({ active, past });
}
