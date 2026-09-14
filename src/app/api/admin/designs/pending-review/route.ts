import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { printroveProduct } from "@/config/settings";
import { getDesignVersionChain } from "@/lib/design-versions";

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

  // Version-chain awareness (issue #20): an admin reviewing a design that's
  // since been superseded by an already-regenerated sibling should never
  // unknowingly approve stale art. Cheap in the common case (#17-#19
  // haven't landed yet — every real row today is still "unjudged" with no
  // regeneratedFromDesignId, so this loop makes zero extra queries).
  const withChains = await Promise.all(
    designs.map(async (d) => {
      const isSuperseded = d.validationStatus === "superseded";
      const versionChain = isSuperseded
        ? (await getDesignVersionChain(d)).map(({ design: v, isLatest }) => ({
            id: v.id,
            slug: v.slug,
            title: v.title,
            validationStatus: v.validationStatus,
            isLatest,
          }))
        : undefined;
      return { d, isSuperseded, versionChain };
    })
  );

  return NextResponse.json({
    designs: withChains.map(({ d, isSuperseded, versionChain }) => ({
      id: d.id,
      title: d.title,
      phrase: d.phrase,
      designImagePath: d.designImagePath,
      productImagePath: d.productImagePath,
      designPreviewImagePath: d.designPreviewImagePath,
      productPreviewImagePath: d.productPreviewImagePath,
      backDesignPreviewImagePath: d.backDesignPreviewImagePath,
      variantColor: d.variantColor,
      validationStatus: d.validationStatus,
      isSuperseded,
      versionChain,
      products: d.designProducts.map((p) => ({
        id: p.id,
        category: p.category,
        label: printroveProduct(p.category).categoryLabel,
        status: p.status,
      })),
    })),
  });
}
