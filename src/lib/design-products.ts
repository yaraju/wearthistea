import { prisma } from "@/lib/prisma";
import { printroveProduct } from "@/config/settings";
import { uploadDesign, createProduct, getProduct } from "@/lib/printrove";
import { readImageAsBase64 } from "@/lib/storage";
import { logger } from "@/lib/logger";
import type { DesignProduct } from "@prisma/client";

// Only supported garment color today — see settings.printrove.products and
// the plan doc for why this is a constant, not a parameter, in this pass.
const COLOR = "Black";

/**
 * Ensure a real Printrove product + mockup exists for (design, category,
 * Black), creating it on demand if it doesn't. The single function behind
 * both the brew-time bulk task (/api/tasks/printrove-products) and the
 * customer-facing on-demand poll (/api/designs/[id]/product) — whichever
 * calls first does the work, the other gets the cached row. Idempotent:
 * safe to call concurrently for the same (design, category) pair.
 *
 * Never throws on a Printrove-side failure — always returns a row (callers
 * check `status`/`errorMessage`), matching the convention realize.ts
 * already established for design generation.
 */
export async function ensureDesignProduct(
  designId: string,
  category: string
): Promise<DesignProduct> {
  const existing = await prisma.designProduct.findUnique({
    where: { designId_category_color: { designId, category, color: COLOR } },
  });

  if (existing?.mockupFrontUrl) return existing;

  if (existing?.printroveProductId) {
    return await refreshMockup(existing);
  }

  return await createDesignProduct(designId, category, existing);
}

async function refreshMockup(row: DesignProduct): Promise<DesignProduct> {
  try {
    const { mockup } = await getProduct(Number(row.printroveProductId));
    if (!mockup?.front_mockup) return row; // still pending on Printrove's side
    return await prisma.designProduct.update({
      where: { id: row.id },
      data: {
        mockupFrontUrl: mockup.front_mockup,
        mockupBackUrl: mockup.back_mockup ?? null,
        status: "ready",
      },
    });
  } catch (err) {
    logger.error("[design-products] Mockup poll failed", { designProductId: row.id, error: err });
    return row; // transient — leave status as-is, caller can retry later
  }
}

async function createDesignProduct(
  designId: string,
  category: string,
  existingFailedRow: DesignProduct | null
): Promise<DesignProduct> {
  const product = printroveProduct(category);
  if (!product.enabled || product.category !== category) {
    return upsertFailed(designId, category, product.previewSize, `"${category}" isn't an enabled category.`);
  }

  const design = await prisma.design.findUnique({ where: { id: designId } });
  if (!design) {
    return upsertFailed(designId, category, product.previewSize, "Design not found.");
  }

  const baseVariantId = product.variantMap[`${COLOR}|${product.previewSize}`];
  if (!baseVariantId) {
    return upsertFailed(
      designId,
      category,
      product.previewSize,
      `No Printrove variant configured for ${COLOR}|${product.previewSize} in "${category}".`
    );
  }

  try {
    // Upload the artwork once and persist it on Design — every other
    // category/color combo for this design reuses the same asset.
    let printroveDesignId: number;
    if (design.printroveDesignId) {
      printroveDesignId = Number(design.printroveDesignId);
    } else {
      const printPath = design.designImagePath || design.productImagePath;
      let base64: string;
      try {
        base64 = await readImageAsBase64(printPath);
      } catch {
        if (!design.designImageData) {
          throw new Error("Artwork file is missing and no database copy exists.");
        }
        base64 = design.designImageData;
      }
      printroveDesignId = await uploadDesign(`${design.id}.png`, base64);
      await prisma.design.update({
        where: { id: design.id },
        data: { printroveDesignId: String(printroveDesignId) },
      });
    }

    const created = await createProduct({
      name: `${design.title} — ${product.categoryLabel} preview`,
      designId: printroveDesignId,
      baseVariantId,
      product,
    });

    // Upsert, not create: a concurrent brew-task run and an on-demand
    // customer fetch can race on the same (designId, category, color) —
    // the unique constraint makes this safe either way.
    const row = await prisma.designProduct.upsert({
      where: { designId_category_color: { designId, category, color: COLOR } },
      create: {
        designId,
        category,
        color: COLOR,
        previewSize: product.previewSize,
        printroveProductId: String(created.productId),
        printroveVariantId: created.variantId != null ? String(created.variantId) : null,
        status: "pending",
      },
      update: {
        printroveProductId: String(created.productId),
        printroveVariantId: created.variantId != null ? String(created.variantId) : null,
        status: "pending",
        errorMessage: null,
      },
    });

    // One immediate check — sometimes the mockup is already there.
    return await refreshMockup(row);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Printrove product creation failed.";
    logger.error("[design-products] Failed to create preview product", {
      designId,
      category,
      error: err,
    });
    return upsertFailed(designId, category, product.previewSize, message, existingFailedRow);
  }
}

async function upsertFailed(
  designId: string,
  category: string,
  previewSize: string,
  errorMessage: string,
  existing?: DesignProduct | null
): Promise<DesignProduct> {
  if (existing) {
    return prisma.designProduct.update({
      where: { id: existing.id },
      data: { status: "failed", errorMessage },
    });
  }
  return prisma.designProduct.upsert({
    where: { designId_category_color: { designId, category, color: COLOR } },
    create: { designId, category, color: COLOR, previewSize, status: "failed", errorMessage },
    update: { status: "failed", errorMessage },
  });
}
