import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { generateBatch } from "@/lib/gemini";
import { compositeOnTee } from "@/lib/mockup";
import { saveImage } from "@/lib/storage";
import { getProvider } from "@/lib/print-provider";
import { settings } from "@/config/settings";
import { prompts } from "@/config/prompts";
import { langfuse, getTraceId } from "@/lib/langfuse";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  keyword: z.string().trim().min(2).max(280),
  category: z.string().optional(),
  productType: z.string().optional(),
  color: z.string().optional(),
  style: z.enum(["raster", "svg"]).optional().default("raster"),
});

// Health check and main generation logic
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

  const { keyword, category, productType, color, style } = body;

  const traceId = getTraceId(req);
  const trace = langfuse.trace({
    name: "generate-api",
    id: traceId,
    input: body,
  });

  logger.info(`[Stage 1] Starting generation for keyword: "${keyword}"`, {
    traceId,
    keyword,
    style,
  });

  try {
    const count = settings.optionsPerKeyword;
    // Step 1: Unified Batched Call (Concepts + SVG Previews)
    const batchItems = await generateBatch(keyword, count, style, trace);
    
    const dbSpan = trace.span({ name: "db-operations" });
    const batch = await prisma.batch.create({ data: { keyword } });

    // Step 2: Process batch items in parallel (Storage + Database)
    const designPromises = batchItems.map(async (item, i) => {
      const c = {
        ...item,
        category,
        productType,
        color: color || settings.printify.defaultColor,
      };
      const base = `${i + 1}-${Date.now()}`;
      let designImagePath = "";
      let productImagePath = "";
      const designB64 = item.imageB64 || "";
      let status = item.error ? "failed" : "preview";
      let errorMessage: string | null = item.error || null;

      if (!item.error && designB64) {
        try {
          // Save the initial SVG preview as the design file
          designImagePath = await saveImage(batch.id, `${base}-preview.png`, designB64);

          // Create the mockup preview (Free/Local)
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
              // Mockup is optional, fallback to design file
            }
          }
        } catch (err) {
          status = "failed";
          errorMessage = err instanceof Error ? err.message : String(err);
        }
      }

      return await prisma.design.create({
        data: {
          batchId: batch.id,
          title: c.title,
          phrase: c.phrase,
          visualConcept: c.visualConcept,
          vibe: c.vibe ?? null,
          blurb: c.blurb ?? null,
          designPrompt: `Stage 1: SVG Preview (${style} mode)`,
          productPrompt: `[mockup composite of clean design on ${
            c.color || settings.printify.defaultColor
          } tee]`,
          designImagePath,
          productImagePath,
          designImageData: designImagePath ? designB64 : null,
          designSVGData: item.svg ?? null,
          status,
          errorMessage,
        },
      });
    });

    const designs = await Promise.all(designPromises);
    dbSpan.end({ output: `${designs.length} designs created` });

    trace.update({
      output: { batchId: batch.id, designCount: designs.length },
    });

    logger.info(`[Stage 1] Successfully generated ${designs.length} designs`, {
      traceId,
      batchId: batch.id,
      count: designs.length,
    });

    return NextResponse.json({
      batchId: batch.id,
      keyword,
      designs,
      options: getProvider().options(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Generation failed.";
    trace.update({
      tags: ["error"],
      output: { error: message },
    });
    logger.error(`[Stage 1] Generation failed: ${message}`, {
      traceId,
      error: err,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
