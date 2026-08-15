import { prisma } from "./prisma";
import { ai, generateImage } from "./gemini";
import { settings } from "@/config/settings";
import { prompts, type Concept } from "@/config/prompts";
import { saveImage } from "./storage";
import { removeBgB64 } from "./background-removal";
import { svgToPng } from "./svg-utils";
import { compositeOnTee } from "./mockup";

/**
 * Stage 2: Realize a design into high-resolution print-ready output.
 * For Raster: High-Res Nano Banana Pro + Local Background Removal.
 * For SVG: Sharp high-res rasterization.
 */
export async function realizeDesign(designId: string) {
  const design = await prisma.design.findUnique({
    where: { id: designId },
  });

  if (!design) throw new Error("Design not found.");
  // If already realized, just return it.
  if (design.status === "generated") return design;

  const isRaster = design.designPrompt.toLowerCase().includes("raster");
  
  let finalDesignB64 = "";
  const finalStatus = "generated";

  try {
    if (isRaster) {
      // Stage 2 (Raster): High-res Imagen realization
      let spatialPrompt = "";
      
      // Spatial Mapping: Describe the layout of the SVG wireframe to guide Imagen
      if (design.designSVGData) {
        try {
          const layoutRes = await ai().models.generateContent({
            model: settings.gemini.flashLiteModel,
            contents: [
              { 
                role: "user", 
                parts: [{ text: `Describe the spatial layout of this SVG in one short sentence for an image generation prompt. Focus on the relative positions of text and graphic elements: \n\n${design.designSVGData}` }] 
              },
            ],
          });
          const layoutDesc = layoutRes.text;
          if (layoutDesc) {
            spatialPrompt = `Follow this layout precisely: ${layoutDesc.trim()}. `;
          }
        } catch (e) {
          console.warn("Spatial mapping failed, proceeding with standard prompt.", e);
        }
      }

      const concept: Concept = {
        title: design.title,
        phrase: design.phrase,
        visualConcept: design.visualConcept,
        vibe: design.vibe || undefined,
        blurb: design.blurb || undefined,
        color: design.variantColor || settings.printify.defaultColor,
      };

      const fullPrompt = `${spatialPrompt}${prompts.designImage(concept)}`;
      
      // Generate with Nano Banana Pro
      const rawImageB64 = await generateImage(fullPrompt, settings.gemini.imagenFastModel);
      
      // Local Background Removal for transparent alpha channel
      finalDesignB64 = await removeBgB64(rawImageB64);
    } else {
      // Stage 2 (SVG): High-res rasterization of existing vector data
      if (!design.designSVGData) throw new Error("SVG data missing for realization.");
      finalDesignB64 = await svgToPng(design.designSVGData);
    }

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

    return await prisma.design.update({
      where: { id: designId },
      data: {
        designImagePath,
        productImagePath,
        designImageData: finalDesignB64,
        status: finalStatus,
        designPrompt: isRaster 
          ? `Stage 2: Realized (Nano Banana Pro + Local BG Removal)` 
          : `Stage 2: Realized (SVG High-Res)`,
      },
    });

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return await prisma.design.update({
      where: { id: designId },
      data: {
        status: "failed",
        errorMessage,
      },
    });
  }
}
