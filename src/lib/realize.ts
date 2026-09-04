import { prisma } from "./prisma";
import { renderConceptArt, isTransientProviderError } from "./gemini";
import { settings } from "@/config/settings";
import { prompts, type Concept } from "@/config/prompts";
import { saveImage } from "./storage";
import { svgToPng } from "./svg-utils";
import { compositeOnTee } from "./mockup";
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

  try {
    if (useImageModel) {
      const concept: Concept = {
        title: design.title,
        phrase: design.phrase,
        visualConcept: design.visualConcept,
        vibe: design.vibe || undefined,
        blurb: design.blurb || undefined,
        color: design.variantColor || settings.printify.defaultColor,
        artStyle: design.style === "svg" ? "svg" : "raster",
      };

      // Kept for the designPrompt debug/replay field below — renderConceptArt
      // recomputes this itself from `concept` rather than taking it as input.
      fullPrompt = concept.artStyle === "svg" ? prompts.designImageArtOnly(concept) : prompts.designImage(concept);

      finalDesignB64 = await renderConceptArt(concept, observation);
    } else {
      // Legacy: high-res rasterization of previously stored vector data.
      const svgObservation = observation.span({ name: "svgToPng-highres" });
      finalDesignB64 = await svgToPng(design.designSVGData!);
      svgObservation.end({ output: "success" });
    }

    const storageObservation = observation.span({ name: "saveImages" });
    // Save final high-res image (replaces the preview path)
    const designImagePath = await saveImage(design.batchId, `${design.id}-final.png`, finalDesignB64);
    
    // Update mockup with final high-res image
    let productImagePath = design.productImagePath;
    if (settings.images.generateProductShot) {
      try {
        const productB64 = await compositeOnTee(
          finalDesignB64,
          design.variantColor || settings.printify.defaultColor
        );
        productImagePath = await saveImage(design.batchId, `${design.id}-product-final.png`, productB64);
      } catch (err) {
        console.error("Mockup update failed during realization:", err);
      }
    }
    storageObservation.end({ output: "success" });

    const updated = await prisma.design.update({
      where: { id: designId },
      data: {
        designImagePath,
        productImagePath,
        designImageData: finalDesignB64,
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
