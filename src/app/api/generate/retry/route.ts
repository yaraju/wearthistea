import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { renderConceptArt } from "@/lib/gemini";
import type { Concept } from "@/config/prompts";
import { compositeOnTee } from "@/lib/mockup";
import { saveImage } from "@/lib/storage";
import { settings } from "@/config/settings";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  designId: z.string(),
});

export async function POST(req: Request) {
  let body;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Missing designId." }, { status: 400 });
  }

  const { designId } = body;

  try {
    const design = await prisma.design.findUnique({
      where: { id: designId },
    });

    if (!design) {
      return NextResponse.json({ error: "Design not found." }, { status: 404 });
    }

    // Rebuild the concept from the stored fields (title/phrase/visual/style)
    // and re-render through the same path generateBatch uses — not a bare
    // replay of designPrompt, which for "svg"-style designs is only the
    // illustration half; a retry needs to redo the Satori text compositing
    // too, not just regenerate the art-only layer.
    const concept: Concept = {
      title: design.title,
      phrase: design.phrase,
      visualConcept: design.visualConcept,
      vibe: design.vibe ?? undefined,
      blurb: design.blurb ?? undefined,
      color: design.variantColor || settings.printify.defaultColor,
      artStyle: design.style === "svg" ? "svg" : "raster",
    };
    const designB64 = await renderConceptArt(concept);

    const base = `${design.id}-${Date.now()}`;
    const designImagePath = await saveImage(design.batchId, `${base}-design.png`, designB64);

    let productImagePath = design.productImagePath;
    if (settings.images.generateProductShot) {
      try {
        const productB64 = await compositeOnTee(
          designB64,
          design.variantColor || settings.printify.defaultColor
        );
        productImagePath = await saveImage(
          design.batchId,
          `${base}-product.png`,
          productB64
        );
      } catch {
        // Mockup is optional, fallback to design file
      }
    }

    const updated = await prisma.design.update({
      where: { id: designId },
      data: {
        designImagePath,
        productImagePath,
        designImageData: designB64,
        status: "generated",
        errorMessage: null,
      },
    });

    return NextResponse.json({ design: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Retry failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
