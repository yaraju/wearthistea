import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { printroveProduct } from "@/config/settings";

export const runtime = "nodejs";

// Designs that need admin attention: at least one (category, color) combo
// is unreviewed AND has a real buyer waiting on it (a pending/pending_
// payment Order) — brew time creates unreviewed preview rows for every
// design eagerly, so gating on "has an order" here keeps the queue to
// designs someone actually wants, not every design ever brewed. Once a
// design qualifies, the modal shows ALL of its unreviewed combos (not just
// the ordered one) so an admin can clear the whole design in one visit.
export async function GET(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const waiting = await prisma.designProduct.findMany({
    where: {
      approvalStatus: "unreviewed",
      orders: { some: { status: { in: ["pending", "pending_payment"] } } },
    },
    select: { designId: true },
    distinct: ["designId"],
  });

  const designs = await prisma.design.findMany({
    where: { id: { in: waiting.map((w) => w.designId) } },
    include: {
      designProducts: {
        where: { approvalStatus: "unreviewed" },
        orderBy: { category: "asc" },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return NextResponse.json({
    designs: designs.map((d) => ({
      id: d.id,
      title: d.title,
      phrase: d.phrase,
      designImagePath: d.designImagePath,
      productImagePath: d.productImagePath,
      products: d.designProducts.map((p) => ({
        id: p.id,
        category: p.category,
        label: printroveProduct(p.category).categoryLabel,
        status: p.status,
      })),
    })),
  });
}
