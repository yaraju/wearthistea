import { prisma } from "./prisma";
import type { SearchHit } from "./design-search";
import type { DesignMatchDTO } from "./types";

/**
 * Shared shaping for any semantic-match result surfaced to a customer
 * (pre-brewed matches on the brew page, "similar designs" on the account
 * page) — fetches each hit's Design + DesignProduct rows and computes the
 * "Taste-Tested"/"Pending Taste-Test" badge from approval state.
 */
export async function toDesignMatchDTOs(hits: SearchHit[]): Promise<DesignMatchDTO[]> {
  if (hits.length === 0) return [];

  const designs = await prisma.design.findMany({
    where: { id: { in: hits.map((h) => h.designId) } },
    include: { designProducts: { select: { approvalStatus: true } } },
  });
  const byId = new Map(designs.map((d) => [d.id, d]));

  return hits
    .map((hit) => {
      const d = byId.get(hit.designId);
      if (!d) return null;
      const reviewBadge: DesignMatchDTO["reviewBadge"] = d.designProducts.some(
        (dp) => dp.approvalStatus === "approved"
      )
        ? "taste-tested"
        : "pending-taste-test";
      return {
        id: d.id,
        slug: d.slug,
        title: d.title,
        phrase: d.phrase,
        blurb: d.blurb,
        productPreviewImagePath: d.productPreviewImagePath,
        designPreviewImagePath: d.designPreviewImagePath,
        variantColor: d.variantColor,
        distance: hit.distance,
        reviewBadge,
      };
    })
    .filter((m): m is DesignMatchDTO => m !== null);
}
