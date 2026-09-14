import { prisma } from "@/lib/prisma";
import { printroveProduct } from "@/config/settings";
import { uploadDesign, createProduct, getProduct, trimDesign } from "@/lib/printrove";
import type { BackLayout } from "@/lib/back-design";
import { readImageAsBase64 } from "@/lib/storage";
import { logger } from "@/lib/logger";
import type { Design, DesignProduct } from "@prisma/client";

// Fallback only for a legacy row that predates #10's self-reported
// Design.variantColor (every design generated since always has one — see
// design-render.ts). Never used to override a design's actual color — see
// #5: this file used to hardcode every real Printrove product to a fixed
// "Black" regardless of what color the art was actually rendered/judged
// for; now it always follows design.variantColor, falling back to this
// constant only when that field is genuinely unset.
const DEFAULT_COLOR = "Black";

/**
 * Ensure a real Printrove product + mockup exists for (design, category,
 * design.variantColor), creating it on demand if it doesn't. The single
 * function behind both the brew-time bulk task
 * (/api/tasks/printrove-products) and the customer-facing on-demand poll
 * (/api/designs/[id]/product) — whichever calls first does the work, the
 * other gets the cached row. Idempotent: safe to call concurrently for the
 * same (design, category) pair.
 *
 * Never throws on a Printrove-side failure — always returns a row (callers
 * check `status`/`errorMessage`), matching the convention realize.ts
 * already established for design generation.
 */
export async function ensureDesignProduct(
  designId: string,
  category: string
): Promise<DesignProduct> {
  const design = await prisma.design.findUnique({ where: { id: designId } });
  if (!design) {
    return upsertFailed(designId, category, DEFAULT_COLOR, "unknown", "Design not found.");
  }
  const color = design.variantColor || DEFAULT_COLOR;

  const existing = await prisma.designProduct.findUnique({
    where: { designId_category_color: { designId, category, color } },
  });

  if (existing?.mockupFrontUrl) return existing;

  if (existing?.printroveProductId) {
    return await refreshMockup(existing);
  }

  return await createDesignProduct(design, category, color, existing);
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
  design: Design,
  category: string,
  color: string,
  existingFailedRow: DesignProduct | null
): Promise<DesignProduct> {
  const designId = design.id;
  const product = printroveProduct(category);
  if (!product.enabled || product.category !== category) {
    return upsertFailed(designId, category, color, product.previewSize, `"${category}" isn't an enabled category.`);
  }

  const baseVariantId = product.variantMap[`${color}|${product.previewSize}`];
  if (!baseVariantId) {
    return upsertFailed(
      designId,
      category,
      color,
      product.previewSize,
      `No Printrove variant configured for ${color}|${product.previewSize} in "${category}".`
    );
  }

  try {
    // Always read the artwork bytes — needed both to (maybe) upload it and,
    // regardless of reuse, to compute its real pixel size for placement
    // (see printrove.ts's fitDesignToFrame).
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

    const trimmed = await trimDesign(base64);

    // Upload the artwork once and persist it on Design — every other
    // category/color combo for this design reuses the same asset (the
    // uploaded PNG itself doesn't encode garment color — only which base
    // variant id it gets placed onto at product-creation time does).
    let printroveDesignId: number;
    if (design.printroveDesignId) {
      printroveDesignId = Number(design.printroveDesignId);
    } else {
      printroveDesignId = await uploadDesign(`${design.id}.png`, trimmed.base64);
      await prisma.design.update({
        where: { id: design.id },
        data: { printroveDesignId: String(printroveDesignId) },
      });
    }

    const imageSize = { width: trimmed.width, height: trimmed.height };

    // Back print (cheeky text + QR) — best-effort: a failure here shouldn't
    // block the front-only product from being created, same reasoning as
    // renderDesignArtwork's own non-fatal back-render try/catch.
    let back: { designId: number; imageSize: { width: number; height: number }; layout: BackLayout } | undefined;
    if (design.backDesignImagePath) {
      try {
        const backBase64 = await readImageAsBase64(design.backDesignImagePath);
        const trimmedBack = await trimDesign(backBase64);

        let printroveBackDesignId: number;
        if (design.printroveBackDesignId) {
          printroveBackDesignId = Number(design.printroveBackDesignId);
        } else {
          printroveBackDesignId = await uploadDesign(`${design.id}-back.png`, trimmedBack.base64);
          await prisma.design.update({
            where: { id: design.id },
            data: { printroveBackDesignId: String(printroveBackDesignId) },
          });
        }

        back = {
          designId: printroveBackDesignId,
          imageSize: { width: trimmedBack.width, height: trimmedBack.height },
          layout: (design.backLayout as BackLayout) || "upper-back",
        };
      } catch (err) {
        logger.error("[design-products] Back design upload failed, creating front-only product", {
          designId,
          error: err,
        });
      }
    }

    const created = await createProduct({
      name: `${design.title} — ${product.categoryLabel} preview`,
      designId: printroveDesignId,
      baseVariantId,
      product,
      imageSize,
      back,
    });

    // Upsert, not create: a concurrent brew-task run and an on-demand
    // customer fetch can race on the same (designId, category, color) —
    // the unique constraint makes this safe either way.
    const row = await prisma.designProduct.upsert({
      where: { designId_category_color: { designId, category, color } },
      create: {
        designId,
        category,
        color,
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
    return upsertFailed(designId, category, color, product.previewSize, message, existingFailedRow);
  }
}

async function upsertFailed(
  designId: string,
  category: string,
  color: string,
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
    where: { designId_category_color: { designId, category, color } },
    create: { designId, category, color, previewSize, status: "failed", errorMessage },
    update: { status: "failed", errorMessage },
  });
}
