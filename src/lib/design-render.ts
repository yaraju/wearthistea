import { prisma } from "@/lib/prisma";
import { renderConceptArt, isTransientProviderError } from "@/lib/gemini";
import type { Concept } from "@/config/prompts";
import { compositeOnTee } from "@/lib/mockup";
import { saveImage, hasDurableStorage } from "@/lib/storage";
import { settings } from "@/config/settings";
import { recordGenerateUsage, type RateLimitResult } from "@/lib/rate-limit";
import type { Design } from "@prisma/client";
import type { LangfuseTraceClient } from "langfuse";

export { isTransientProviderError };

/**
 * Render (or re-render) a Design's artwork in place — rebuilds the Concept
 * from the stored creative fields and renders through the same path
 * generateBatch/retry use (not a bare designPrompt replay, which for
 * "svg"-style designs is only the illustration half; a re-render needs to
 * redo the Satori text compositing too). Extracted verbatim from
 * /api/generate/retry so the customer regenerate endpoint
 * (/api/account/orders/[id]/regenerate) can reuse the exact same logic,
 * including rate-limit accounting.
 *
 * Caller is responsible for: confirming the Design row already exists (a
 * not-found design shouldn't spend rate-limit budget — that check happens
 * before this is called), and persisting a "failed" status on error, since
 * that differs slightly between callers (retry marks the SAME design
 * failed; regenerate leaves a freshly-cloned design failed and creates no
 * Order).
 */
export async function renderDesignArtwork(
  design: Design,
  trace: LangfuseTraceClient,
  rateLimit: RateLimitResult
) {
  const concept: Concept = {
    title: design.title,
    phrase: design.phrase,
    visualConcept: design.visualConcept,
    vibe: design.vibe ?? undefined,
    blurb: design.blurb ?? undefined,
    color: design.variantColor || settings.printify.defaultColor,
    artStyle: design.style === "svg" ? "svg" : "raster",
  };

  let designB64: string;
  try {
    designB64 = await renderConceptArt(concept, trace);
    await recordGenerateUsage(rateLimit);
  } catch (err) {
    // Gemini's own 429/503 (its quota/capacity, not ours) isn't the
    // caller's fault — don't spend their free-generation budget on it.
    if (!isTransientProviderError(err)) await recordGenerateUsage(rateLimit);
    throw err;
  }

  const base = `${design.id}-${Date.now()}`;
  const designImagePath = await saveImage(design.batchId, `${base}-design.png`, designB64);

  let productImagePath = design.productImagePath;
  if (settings.images.generateProductShot) {
    try {
      const productB64 = await compositeOnTee(
        designB64,
        design.variantColor || settings.printify.defaultColor
      );
      productImagePath = await saveImage(design.batchId, `${base}-product.png`, productB64);
    } catch {
      // Mockup is optional, fallback to design file
    }
  }

  return prisma.design.update({
    where: { id: design.id },
    data: {
      designImagePath,
      productImagePath,
      // Only needed as a lost-file fallback on ephemeral local disk — once
      // GCS is configured, saveImage() above already either durably
      // persisted this or threw, so storing a second copy here would just
      // be permanent, ever-growing database bloat for no benefit.
      designImageData: hasDurableStorage ? null : designB64,
      status: "generated",
      errorMessage: null,
    },
  });
}
