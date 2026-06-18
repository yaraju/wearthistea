import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { generateConcepts, generateImage } from "@/lib/gemini";
import { compositeOnTee } from "@/lib/mockup";
import { saveImage } from "@/lib/storage";
import { getProvider } from "@/lib/print-provider";
import { settings } from "@/config/settings";
import { prompts } from "@/config/prompts";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  keyword: z.string().trim().min(2).max(280),
  category: z.string().optional(),
  productType: z.string().optional(),
  color: z.string().optional(),
});

export async function POST(req: Request) {
  let body;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json(
      { error: "Spill something first — give us 2–280 characters of tea." },
      { status: 400 }
    );
  }

  const { keyword, category, productType, color } = body;

  try {
    const count = settings.optionsPerKeyword;
    const concepts = await generateConcepts(keyword, count);

    const batch = await prisma.batch.create({ data: { keyword } });

    // For each concept: render the clean print file + the product shot in parallel.
    const designPromises = concepts.map(async (concept, i) => {
      const c = {
        ...concept,
        category,
        productType,
        color: color || settings.printify.defaultColor,
      };
      const base = `${i + 1}-${Date.now()}`;
      let designImagePath = "";
      let productImagePath = "";
      let designB64 = "";
      let status = "generated";
      let errorMessage: string | null = null;

      try {
        // One paid AI call: the clean, print-ready design.
        designB64 = await generateImage(prompts.designImage(c));
        designImagePath = await saveImage(batch.id, `${base}-design.png`, designB64);

        // Free: composite that same file onto a tee mockup for the preview.
        if (settings.images.generateProductShot) {
          try {
            const productB64 = await compositeOnTee(
              designB64,
              c.color || settings.printify.defaultColor
            );
            productImagePath = await saveImage(
              batch.id,
              `${base}-product.png`,
              productB64
            );
          } catch {
            // Preview is optional — fall back to showing the raw design file.
          }
        }
      } catch (err) {
        status = "failed";
        errorMessage = err instanceof Error ? err.message : String(err);
      }

      return await prisma.design.create({
        data: {
          batchId: batch.id,
          title: c.title,
          phrase: c.phrase,
          visualConcept: c.visualConcept,
          vibe: c.vibe ?? null,
          blurb: c.blurb ?? null,
          designPrompt: prompts.designImage(c),
          productPrompt: `[mockup composite of clean design on ${
            c.color || settings.printify.defaultColor
          } tee]`,
          designImagePath,
          productImagePath,
          // Store base64 so approval can proceed even after a redeploy wipes the disk.
          designImageData: designImagePath ? designB64 : null,
          status,
          errorMessage,
        },
      });
    });

    const designs = await Promise.all(designPromises);

    return NextResponse.json({
      batchId: batch.id,
      keyword,
      designs,
      options: getProvider().options(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Generation failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
