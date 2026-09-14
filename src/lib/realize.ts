import { prisma } from "./prisma";
import { renderConceptArt, isTransientProviderError } from "./gemini";
import { settings } from "@/config/settings";
import { prompts, type Concept } from "@/config/prompts";
import { saveImageWithPreview, hasDurableStorage, assertDesignPathFieldsShape } from "./storage";
import { svgToPng } from "./svg-utils";
import { compositeOnTee } from "./mockup";
import { renderBackDesignArtwork, type BackLayout } from "./back-design";
import { langfuse } from "./langfuse";

/**
 * (Re)realize a design into high-resolution print-ready output.
 * Since Stage 1 (generateBatch) now renders final art directly, callers only
 * need this for two cases: a legacy "preview"-status row from before that
 * change, or the buyer picking a different garment color at checkout than
 * the one the art was generated for.
 * For Raster: High-Res Nano Banana Pro + Local Background Removal.
 * For SVG (legacy rows only): Sharp high-res rasterization of stored vector data.
 */
export async function realizeDesign(designId: string, parent?: any) {
  const observation = (parent || langfuse).span({
    name: "realizeDesign",
    input: { designId },
  });

  const design = await prisma.design.findUnique({
    where: { id: designId },
  });

  if (!design) {
    const error = new Error("Design not found.");
    observation.end({ level: "error", statusMessage: error.message });
    throw error;
  }

  // Callers decide whether realization is actually needed (e.g. a legacy
  // "preview" row, or the buyer changed garment color at checkout) — this
  // function always does the work when invoked.
  //
  // Branch on whether there's stored vector data, not on `style`: since
  // Phase 1, "raster" and "svg" are both art-direction choices rendered by
  // the image model (see designImage()'s STYLE branch) — neither produces
  // designSVGData anymore. Only a genuinely legacy hand-drawn-SVG row (from
  // before that change) has designSVGData, and only that row needs the
  // sharp-rasterization path below.
  const useImageModel = !design.designSVGData;

  let finalDesignB64 = "";
  let fullPrompt = "";
  const finalStatus = "generated";
  // Falls back to the pre-existing variantColor for the (legacy) SVG
  // rasterization path below, which doesn't call renderConceptArt and so
  // never resolves a fresh color — see the `useImageModel` branch below for
  // the real (raster/image-model) path, which always overwrites this.
  let resolvedVariantColor = design.variantColor || settings.printify.defaultColor;

  try {
    if (useImageModel) {
      const concept: Concept = {
        title: design.title,
        phrase: design.phrase,
        visualConcept: design.visualConcept,
        vibe: design.vibe || undefined,
        blurb: design.blurb || undefined,
        backPhrase: design.backPhrase || "",
        artStyle: design.style === "svg" ? "svg" : "raster",
      };

      // Kept for the designPrompt debug/replay field below — renderConceptArt
      // recomputes this itself from `concept` rather than taking it as input.
      fullPrompt = concept.artStyle === "svg" ? prompts.designImageArtOnly(concept) : prompts.designImage(concept);

      // renderConceptArt() resolves its own garment color from the actual
      // rendered art (self-reported by the model, or a luminance fallback —
      // see prompts.ts's GARMENT_COLOR_CHOICE and gemini.ts's
      // resolveGarmentColor()) rather than obeying `concept.color` as an
      // instruction — same as design-render.ts's fresh-generation path.
      // Previously this discarded that resolved color and kept using the
      // pre-existing (possibly stale/forced) `design.variantColor` for the
      // mockup composite and back-print ink below, which could produce a
      // mismatch between the actually-rendered art and what got shipped to
      // Printrove — see #23. Now captured and used for both, and persisted
      // below, exactly like a fresh generation.
      const rendered = await renderConceptArt(concept, observation);
      finalDesignB64 = rendered.imageB64;
      resolvedVariantColor = rendered.variantColor;
    } else {
      // Legacy: high-res rasterization of previously stored vector data.
      const svgObservation = observation.span({ name: "svgToPng-highres" });
      finalDesignB64 = await svgToPng(design.designSVGData!);
      svgObservation.end({ output: "success" });
    }

    const storageObservation = observation.span({ name: "saveImages" });
    // Save final high-res image (replaces the preview path)
    const { path: designImagePath, previewPath: designPreviewImagePath } = await saveImageWithPreview(
      design.batchId,
      `${design.id}-final.png`,
      finalDesignB64
    );

    // Update mockup with final high-res image
    let productImagePath = design.productImagePath;
    let productPreviewImagePath = design.productPreviewImagePath;
    if (settings.images.generateProductShot) {
      try {
        const productB64 = await compositeOnTee(finalDesignB64, resolvedVariantColor);
        const saved = await saveImageWithPreview(design.batchId, `${design.id}-product-final.png`, productB64);
        productImagePath = saved.path;
        productPreviewImagePath = saved.previewPath;
      } catch (err) {
        console.error("Mockup update failed during realization:", err);
      }
    }

    // Back print's ink color depends on garment color (isDarkGarment), same
    // as the front art, so a color change needs it re-rendered too. Optional
    // and non-fatal — a QR/Satori failure here must never fail a realization
    // the buyer is waiting on for their actual purchase.
    let backDesignImagePath = design.backDesignImagePath;
    let backDesignPreviewImagePath = design.backDesignPreviewImagePath;
    if (design.backPhrase) {
      try {
        const backB64 = await renderBackDesignArtwork(design.backPhrase, {
          layout: (design.backLayout as BackLayout) || "upper-back",
          color: resolvedVariantColor,
        });
        const saved = await saveImageWithPreview(design.batchId, `${design.id}-back-final.png`, backB64);
        backDesignImagePath = saved.path;
        backDesignPreviewImagePath = saved.previewPath;
      } catch (err) {
        console.error("Back design render failed during realization:", err);
      }
    }
    storageObservation.end({ output: "success" });

    // Static shape check, no GCS API call — catches a bypassed/malformed
    // path (see storage.ts's assertDesignPathFieldsShape) before it ever
    // reaches the DB. Deliberately unconditional on GCS_BUCKET — see that
    // function's doc comment for why.
    assertDesignPathFieldsShape({
      designImagePath,
      designPreviewImagePath,
      productImagePath,
      productPreviewImagePath,
      backDesignImagePath,
      backDesignPreviewImagePath,
    });

    const updated = await prisma.design.update({
      where: { id: designId },
      data: {
        designImagePath,
        designPreviewImagePath,
        productImagePath,
        productPreviewImagePath,
        backDesignImagePath,
        backDesignPreviewImagePath,
        // Ink color may have just changed (new garment color) — clear the
        // stale PrintRove upload id so the next touch re-uploads the new art
        // instead of reusing the old color's asset.
        ...(design.backPhrase ? { printroveBackDesignId: null } : {}),
        // See the identical comment in /api/generate/retry — only needed as
        // a lost-file fallback when GCS isn't configured.
        designImageData: hasDurableStorage ? null : finalDesignB64,
        // Persist whatever color this render actually resolved to (or, for
        // the legacy SVG path, the pre-existing value) — see #23: this used
        // to stay at whatever checkout had just force-written, which could
        // disagree with the art/back-print that were just rendered above.
        variantColor: resolvedVariantColor,
        status: finalStatus,
        // Keep designPrompt replayable: for the raster path, store the exact
        // prompt that produced this art (so a later retry reproduces it);
        // the SVG-rasterize path has no such prompt, so leave it untouched.
        ...(useImageModel ? { designPrompt: fullPrompt } : {}),
      },
    });

    observation.end({ output: "success" });
    return { ...updated, transientProviderError: false };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    observation.end({ level: "error", statusMessage: errorMessage });
    const failed = await prisma.design.update({
      where: { id: designId },
      data: {
        status: "failed",
        errorMessage,
      },
    });
    // Not persisted — read by /api/realize to decide whether this attempt
    // should count against the caller's free-generation budget.
    return { ...failed, transientProviderError: isTransientProviderError(err) };
  }
}
