import { prisma } from "@/lib/prisma";
import { renderConceptArt, renderConceptArtFix, isTransientProviderError } from "@/lib/gemini";
import type { Concept } from "@/config/prompts";
import { compositeOnTee } from "@/lib/mockup";
import { renderBackDesignArtwork, type BackLayout } from "@/lib/back-design";
import { saveImageWithPreview, hasDurableStorage, assertDesignPathFieldsShape } from "@/lib/storage";
import { settings } from "@/config/settings";
import { recordGenerateUsage, type RateLimitResult } from "@/lib/rate-limit";
import { enqueuePrintroveProducts } from "@/lib/tasks";
import { logger } from "@/lib/logger";
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
 *
 * `edit` (issue #15) switches this from a from-scratch re-roll to a
 * targeted image-to-image FIX: when set, `edit.sourceImageB64` (the
 * design-being-regenerated-FROM's current art) is paired with
 * `edit.instruction` (the judge's regenerationPrompt) via
 * gemini.ts's renderConceptArtFix() instead of renderConceptArt(). Every
 * step after that point — variantColor persistence, mockup compositing, and
 * critically the back-print re-render below — is untouched and runs
 * identically either way: the back-print composite is ALWAYS rendered
 * against the freshly-resolved `variantColor` local (never a stale DB
 * read), which is what makes it structurally correct whether or not this
 * particular render actually changed the color — the same standing rule
 * design-fixes.ts's relabelVariantColor() enforces explicitly, satisfied
 * here for free by not caching a color from before this render ran.
 */
export async function renderDesignArtwork(
  design: Design,
  trace: LangfuseTraceClient,
  rateLimit: RateLimitResult,
  edit?: { sourceImageB64: string; instruction: string }
) {
  // `color` is intentionally omitted here — garment color is no longer a
  // caller-supplied instruction (see prompts.ts's GARMENT_COLOR_CHOICE):
  // renderConceptArt()/renderConceptArtFix() below resolve it FROM the
  // actual rendered pixels (the model's own self-report, or a luminance
  // fallback) and return it alongside the image, so it's written to
  // `Design.variantColor` for the first time right after this, not read
  // from it beforehand.
  const concept: Concept = {
    title: design.title,
    phrase: design.phrase,
    visualConcept: design.visualConcept,
    vibe: design.vibe ?? undefined,
    blurb: design.blurb ?? undefined,
    backPhrase: design.backPhrase || "",
    artStyle: design.style === "svg" ? "svg" : "raster",
  };

  let designB64: string;
  let variantColor: string;
  try {
    const rendered = edit
      ? await renderConceptArtFix(concept, edit.sourceImageB64, edit.instruction, trace)
      : await renderConceptArt(concept, trace);
    designB64 = rendered.imageB64;
    variantColor = rendered.variantColor;
    await recordGenerateUsage(rateLimit);
  } catch (err) {
    // Gemini's own 429/503 (its quota/capacity, not ours) isn't the
    // caller's fault — don't spend their free-generation budget on it.
    if (!isTransientProviderError(err)) await recordGenerateUsage(rateLimit);
    throw err;
  }

  // Persist variantColor durably BEFORE rendering the back-print composite
  // below — issue #13's chain requires this ordering explicitly, since
  // back-print ink color is derived from isDarkGarment(variantColor) (see
  // back-design.ts's renderBackDesignArtwork). The back-print call a few
  // lines down already uses the local `variantColor` value directly (not a
  // DB read), so this write is behaviorally a no-op on the happy path —
  // it's here so the resolved color is durable on the row immediately
  // rather than only at the very end alongside every other field, in case
  // a later step in this function throws. Non-fatal: the final
  // prisma.design.update below writes variantColor again regardless.
  await prisma.design.update({ where: { id: design.id }, data: { variantColor } }).catch((err) => {
    logger.error(
      "[renderDesignArtwork] Failed to persist early variantColor write (non-fatal, final update will retry)",
      { designId: design.id, error: err }
    );
  });

  const base = `${design.id}-${Date.now()}`;
  const { path: designImagePath, previewPath: designPreviewImagePath } = await saveImageWithPreview(
    design.batchId,
    `${base}-design.png`,
    designB64
  );

  let productImagePath = design.productImagePath;
  let productPreviewImagePath = design.productPreviewImagePath;
  if (settings.images.generateProductShot) {
    try {
      const productB64 = await compositeOnTee(designB64, variantColor);
      const saved = await saveImageWithPreview(design.batchId, `${base}-product.png`, productB64);
      productImagePath = saved.path;
      productPreviewImagePath = saved.previewPath;
    } catch {
      // Mockup is optional, fallback to design file
    }
  }

  // Back print (cheeky payoff line + QR). Deterministic, no LLM/image-model
  // call — cheap enough to (re)render on every front render, which also
  // keeps it fresh whenever backPhrase/backLayout/variantColor change (e.g.
  // an admin "flip" or a regenerate clone). Non-fatal: a Satori/QR hiccup
  // must never fail the front render the customer already spent
  // rate-limit budget waiting on.
  let backDesignImagePath = design.backDesignImagePath;
  let backDesignPreviewImagePath = design.backDesignPreviewImagePath;
  if (design.backPhrase) {
    try {
      const backB64 = await renderBackDesignArtwork(design.backPhrase, {
        layout: (design.backLayout as BackLayout) || "upper-back",
        color: variantColor,
      });
      const saved = await saveImageWithPreview(design.batchId, `${base}-back.png`, backB64);
      backDesignImagePath = saved.path;
      backDesignPreviewImagePath = saved.previewPath;
    } catch {
      // Back print is optional — front art is what the customer is waiting on.
    }
  }

  // Static shape check, no GCS API call — catches a bypassed/malformed path
  // (see storage.ts's assertDesignPathFieldsShape) before it ever reaches
  // the DB. Deliberately unconditional on GCS_BUCKET — see that function's
  // doc comment for why.
  assertDesignPathFieldsShape({
    designImagePath,
    designPreviewImagePath,
    productImagePath,
    productPreviewImagePath,
    backDesignImagePath,
    backDesignPreviewImagePath,
  });

  return prisma.design.update({
    where: { id: design.id },
    data: {
      designImagePath,
      designPreviewImagePath,
      productImagePath,
      productPreviewImagePath,
      backDesignImagePath,
      backDesignPreviewImagePath,
      // Only needed as a lost-file fallback on ephemeral local disk — once
      // GCS is configured, saveImage() above already either durably
      // persisted this or threw, so storing a second copy here would just
      // be permanent, ever-growing database bloat for no benefit.
      designImageData: hasDurableStorage ? null : designB64,
      // First write of variantColor for a fresh design — resolved from the
      // actual rendered art (see renderConceptArt), not chosen upfront.
      variantColor,
      status: "generated",
      errorMessage: null,
    },
  });
}

export type FinalizeDesignRenderResult =
  | { ok: true; design: Design }
  | { ok: false; error: string; transient: boolean };

/**
 * renderDesignArtwork() + the two things every caller wraps it in: queueing
 * the Printrove preview-product build once art lands, and persisting a
 * "failed" status/errorMessage on error. Extracted from /api/generate/retry
 * (its original home) so /api/tasks/render-design — the server-side dispatch
 * a Cloud Task fires, with no end-user request/response to shape errors
 * around — can share the exact same behavior instead of re-implementing it.
 *
 * Always marks the design "failed" on error, even a transient provider one
 * (matches /api/generate/retry's existing behavior: a design left at
 * "generating" forever would look stuck, not failed, on reload — and the
 * card's own "Retry Render" button is the fallback if nothing else recovers
 * it). `transient` is still returned so a Cloud-Tasks-backed caller can
 * answer with a 5xx and let the queue's own redelivery retry in the
 * background per its retry-config — if that redelivery succeeds, it just
 * overwrites this row back to "generated", so marking it failed now doesn't
 * block that.
 *
 * Never throws: callers get a tagged result back and decide their own
 * response shape (HTTP JSON vs. a task's 200/502).
 */
export async function finalizeDesignRender(
  design: Design,
  trace: LangfuseTraceClient,
  rateLimit: RateLimitResult
): Promise<FinalizeDesignRenderResult> {
  try {
    const updated = await renderDesignArtwork(design, trace, rateLimit);
    trace.update({ output: { designId: design.id, status: updated.status } });

    // Brew Printrove preview products for every enabled category now, so
    // they're usually ready by the time a customer picks this design. Never
    // fails the render — the artwork already rendered successfully, which is
    // what the customer is waiting on.
    try {
      await enqueuePrintroveProducts(design.id);
    } catch (err) {
      logger.error("[finalizeDesignRender] Failed to enqueue Printrove preview creation", {
        designId: design.id,
        error: err,
      });
    }

    return { ok: true, design: updated };
  } catch (err) {
    const transient = isTransientProviderError(err);
    const message = err instanceof Error ? err.message : "Render failed.";
    trace.update({ tags: ["error"], output: { error: message } });
    logger.error(`[finalizeDesignRender] Render failed for design ${design.id}: ${message}`, {
      designId: design.id,
      error: err,
    });
    await prisma.design
      .update({ where: { id: design.id }, data: { status: "failed", errorMessage: message } })
      .catch((updateErr) => {
        logger.error(`[finalizeDesignRender] Failed to persist failure status for design ${design.id}`, {
          designId: design.id,
          error: updateErr,
        });
      });
    return { ok: false, error: message, transient };
  }
}
