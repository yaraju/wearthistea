/**
 * Dispatch + persistence for the judge -> fix -> judge chain's programmatic
 * fix step (issue #14; queue wiring landed in #13, see
 * src/lib/validation-chain.ts's runFixStep()). The actual fix
 * implementations live in src/lib/design-fixes.ts (plural) — they're pure
 * computations with no DB access; this module is the one place that turns
 * what they return into a real Design row update, following JudgeVerdict.fix
 * (src/lib/design-judge.ts's JudgeFix): "relabel" (correct
 * Design.variantColor to match the art's actual ink direction, raster
 * designs only), "invert-ink" (recolor the svg art's ink pixels in place),
 * or "rerun-bg-removal" (re-run background/alpha cleanup). See
 * prompts.imageReview()'s doc comment for exactly when each applies,
 * particularly the raster-vs-svg distinction between relabel and
 * invert-ink.
 *
 * Signature is fixed by issue #13 so this can be implemented in place
 * without touching any caller: runFixStep() awaits this, expects it to
 * either mutate `design`'s stored artwork/row in place and return normally,
 * or throw to signal the fix genuinely failed.
 *
 * Throwing on failure (instead of silently no-op'ing "success") is
 * deliberate: a fix that pretends to succeed without changing anything would
 * burn one of the two validationFixAttempts budget slots for nothing,
 * invisibly to whoever's debugging why a design keeps landing back at the
 * judge with the same issue. runFixStep() treats a thrown error as a
 * transient task failure — fix-design/route.ts returns a 5xx so Cloud Tasks
 * retries per the design-fix queue's own backoff config, and leaves the
 * design's validationStatus at "regenerating" (unchanged, attempt counter
 * already incremented by judge-design before this was ever called) rather
 * than advancing it — so nothing is lost, the row just sits correctly "in
 * flight" until this succeeds.
 *
 * No top-level `prisma` import, matching validation-chain.ts's own stated
 * convention ("no direct `prisma` import at the top level") — prisma is
 * loaded dynamically inside applyProgrammaticFix() instead, so importing
 * this module (which validation-chain.ts does statically) never eagerly
 * instantiates a PrismaClient, e.g. when a test drives validation-chain.ts
 * with a fully faked DesignStore/applyFix and never intends to touch prisma
 * at all.
 */
import type { Design } from "@prisma/client";
import type { JudgeVerdict } from "./design-judge";
import {
  relabelVariantColor,
  invertInkColor,
  rerunBackgroundRemoval,
  InvertInkStyleError,
  BackgroundRemovalRegressionError,
} from "./design-fixes";
import { assertDesignPathFieldsShape, saveImageWithPreview, readImageAsBase64, hasDurableStorage } from "./storage";
import { logger } from "./logger";

export { InvertInkStyleError, BackgroundRemovalRegressionError };

/** Same GCS-then-designImageData-fallback pattern as validation-chain.ts's
 * loadDesignImageBase64 / fulfillment.ts's Printrove upload. Kept local
 * here (rather than imported from validation-chain.ts) to avoid a circular
 * import — validation-chain.ts imports applyProgrammaticFix from this
 * module already. */
async function loadFrontArtBase64(design: Pick<Design, "designImagePath" | "designImageData">): Promise<string> {
  try {
    return await readImageAsBase64(design.designImagePath);
  } catch {
    if (!design.designImageData) {
      throw new Error("applyProgrammaticFix: front artwork file is missing and no database copy exists.");
    }
    return design.designImageData;
  }
}

/**
 * Invalidate whatever Printrove-side cache is now stale because this
 * design's stored artwork and/or variantColor changed underneath it —
 * mirrors /api/admin/designs/[id]/back-layout's own reset, the only other
 * place this app already mutates a design's art/color in place after
 * creation. Without this, a DesignProduct row's cached mockupFrontUrl
 * short-circuits ensureDesignProduct() (design-products.ts) forever, so a
 * customer/admin would keep seeing the pre-fix mockup even after the
 * underlying art/color was corrected. Best-effort/non-fatal — the fix
 * itself already succeeded by the time this runs, and a stale mockup that
 * eventually gets rebuilt on the next poll is a much smaller problem than
 * losing the fix.
 */
async function invalidatePrintroveCache(designId: string, opts: { front?: boolean; back?: boolean }): Promise<void> {
  const { prisma } = await import("./prisma");

  const designPatch: Record<string, null> = {};
  if (opts.front) designPatch.printroveDesignId = null;
  if (opts.back) designPatch.printroveBackDesignId = null;
  if (Object.keys(designPatch).length > 0) {
    await prisma.design.update({ where: { id: designId }, data: designPatch }).catch((err) => {
      logger.error("[applyProgrammaticFix] Failed to reset printrove*DesignId cache (non-fatal)", {
        designId,
        error: err,
      });
    });
  }

  await prisma.designProduct
    .updateMany({
      where: { designId },
      data: {
        printroveProductId: null,
        printroveVariantId: null,
        mockupFrontUrl: null,
        mockupBackUrl: null,
        status: "pending",
        errorMessage: null,
      },
    })
    .catch((err) => {
      logger.error("[applyProgrammaticFix] Failed to invalidate stale DesignProduct rows (non-fatal)", {
        designId,
        error: err,
      });
    });
}

export async function applyProgrammaticFix(design: Design, verdict: JudgeVerdict): Promise<void> {
  const { prisma } = await import("./prisma");

  switch (verdict.fix) {
    case "relabel": {
      const result = await relabelVariantColor(design);

      let backDesignImagePath = design.backDesignImagePath;
      let backDesignPreviewImagePath = design.backDesignPreviewImagePath;
      if (result.backDesignImageB64) {
        const saved = await saveImageWithPreview(
          design.batchId,
          `${design.id}-relabel-${Date.now()}-back.png`,
          result.backDesignImageB64
        );
        backDesignImagePath = saved.path;
        backDesignPreviewImagePath = saved.previewPath;
      }

      // Static shape check before the write — see storage.ts's
      // assertDesignPathFieldsShape (issue #25).
      assertDesignPathFieldsShape({ backDesignImagePath, backDesignPreviewImagePath });

      await prisma.design.update({
        where: { id: design.id },
        data: { variantColor: result.variantColor, backDesignImagePath, backDesignPreviewImagePath },
      });

      // Only the back art (if any) actually changed bytes; the front art's
      // uploaded PNG doesn't encode garment color (design-products.ts's
      // ensureDesignProduct doc comment), so printroveDesignId stays valid.
      if (result.backDesignImageB64) {
        await invalidatePrintroveCache(design.id, { back: true });
      } else {
        // No back print to invalidate, but the (designId, category, color)
        // cache key ensureDesignProduct() looks up by IS now different —
        // still clear any stale DesignProduct rows so a rebuild happens
        // against the new color rather than serving old-color leftovers.
        await invalidatePrintroveCache(design.id, {});
      }
      return;
    }

    case "invert-ink": {
      const imageB64 = await loadFrontArtBase64(design);
      // Throws InvertInkStyleError (not a silent no-op) for style !== "svg" —
      // see design-fixes.ts's doc comment.
      const invertedB64 = await invertInkColor(imageB64, design);

      const saved = await saveImageWithPreview(
        design.batchId,
        `${design.id}-invert-${Date.now()}-design.png`,
        invertedB64
      );
      assertDesignPathFieldsShape({ designImagePath: saved.path, designPreviewImagePath: saved.previewPath });

      await prisma.design.update({
        where: { id: design.id },
        data: {
          designImagePath: saved.path,
          designPreviewImagePath: saved.previewPath,
          // Only needed as a lost-file fallback on ephemeral local disk —
          // once GCS is configured, saveImageWithPreview above already
          // either durably persisted this or threw (design-render.ts's own
          // precedent for this exact pattern).
          designImageData: hasDurableStorage ? null : invertedB64,
        },
      });
      await invalidatePrintroveCache(design.id, { front: true });
      return;
    }

    case "rerun-bg-removal": {
      const imageB64 = await loadFrontArtBase64(design);
      // Throws BackgroundRemovalRegressionError (not a silent no-op) if the
      // result isn't at least as transparent as the input — see
      // design-fixes.ts's doc comment.
      const cleanedB64 = await rerunBackgroundRemoval(imageB64);

      const saved = await saveImageWithPreview(
        design.batchId,
        `${design.id}-bgfix-${Date.now()}-design.png`,
        cleanedB64
      );
      assertDesignPathFieldsShape({ designImagePath: saved.path, designPreviewImagePath: saved.previewPath });

      await prisma.design.update({
        where: { id: design.id },
        data: {
          designImagePath: saved.path,
          designPreviewImagePath: saved.previewPath,
          designImageData: hasDurableStorage ? null : cleanedB64,
        },
      });
      await invalidatePrintroveCache(design.id, { front: true });
      return;
    }

    default:
      // "none"/"regenerate" should never reach this function — runJudgeStep
      // (validation-chain.ts) only enqueues fix-design for fix in
      // {"relabel","invert-ink","rerun-bg-removal"}. Throwing (not a silent
      // no-op) surfaces a routing bug loudly instead of burning a fix
      // attempt for nothing.
      throw new Error(
        `applyProgrammaticFix() called with a non-programmatic fix="${verdict.fix}" for design ${design.id} — ` +
          `only "relabel"/"invert-ink"/"rerun-bg-removal" are dispatched here; "none"/"regenerate" should never ` +
          `reach this function (see validation-chain.ts's runJudgeStep routing).`
      );
  }
}
