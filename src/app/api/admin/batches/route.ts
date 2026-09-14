import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";

// Admin queue feed. ?status=pending (default) filters to items awaiting approval.
export async function GET(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const status = url.searchParams.get("status");

  try {
    const orders = await prisma.order.findMany({
      where: status && status !== "all" ? { status } : undefined,
      orderBy: { updatedAt: "desc" },
      include: {
        design: {
          include: { batch: { select: { keyword: true, createdAt: true } } },
        },
        designProduct: { select: { mockupFrontUrl: true } },
      },
      take: 200,
    });

    const counts = await prisma.order.groupBy({
      by: ["status"],
      _count: { _all: true },
    });

    return NextResponse.json({
      orders: orders.map(({ design, designProduct, ...o }) => ({
        ...o,
        title: design.title,
        phrase: design.phrase,
        vibe: design.vibe,
        productImagePath: design.productImagePath,
        designImagePath: design.designImagePath,
        productPreviewImagePath: design.productPreviewImagePath,
        designPreviewImagePath: design.designPreviewImagePath,
        hasImageData: Boolean(design.designImageData),
        printroveMockupUrl: designProduct?.mockupFrontUrl ?? null,
        batch: design.batch,
        // Plain field reads only — see design-versions.ts's module comment:
        // an order-linked view must NEVER call resolveLatestDesignVersion(),
        // this is purely "heads up, a newer version exists" metadata about
        // the exact Design row this Order references.
        designSlug: design.slug,
        designValidationStatus: design.validationStatus,
      })),
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Database error.";
    const hint = /database|connect|P10\d\d|ECONN/i.test(message)
      ? "Is DATABASE_URL set and did you run `npx prisma db push`?"
      : undefined;
    return NextResponse.json({ error: message, hint }, { status: 500 });
  }
}
