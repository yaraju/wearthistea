import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { generateConcepts } from "@/lib/gemini";
import { getProvider } from "@/lib/print-provider";
import { settings } from "@/config/settings";
import { prompts } from "@/config/prompts";
import { langfuse, getTraceId } from "@/lib/langfuse";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  keyword: z.string().trim().min(2).max(280),
  // The picker on the landing page sends the product's numeric id (which we
  // set equal to its Printrove subtypeId) — the reliable way to resolve
  // which of our supported categories was chosen. `category`/`productType`
  // are still accepted as free-text labels for prompt-writing/back-compat,
  // but productId is what actually selects the fulfillment config.
  productId: z.number().optional(),
  category: z.string().optional(),
  productType: z.string().optional(),
  color: z.string().optional(),
  style: z.enum(["raster", "svg"]).optional().default("raster"),
});

/** Resolve the picker's productId to one of our supported category keys. */
function resolveCategory(productId?: number): string {
  const match = settings.printrove.products.find(
    (p) => p.enabled && p.subtypeId === productId
  );
  return match?.category ?? "men";
}

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
  const resolvedCategory = resolveCategory(body.productId);

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
    const resolvedColor = color || settings.printify.defaultColor;

    // Stage 1a only: fast concept writing (a couple of seconds). Artwork for
    // each concept is rendered by a separate request per design (fired by the
    // client right after this responds) rather than synchronously here —
    // rendering all N images in one request can take 40-70s+, which exceeds
    // Firebase Hosting's unconfigurable ~60s rewrite-proxy timeout and comes
    // back as an HTML 502 the client can't parse as JSON. See the production
    // incident note in design-quality-improvement-plan.md.
    const concepts = await generateConcepts(
      keyword,
      count,
      { style, category, productType, color: resolvedColor },
      trace
    );

    const batchSpan = trace.span({ name: "create-batch-row" });
    const batch = await prisma.batch.create({ data: { keyword } }).catch((err) => {
      batchSpan.end({ level: "ERROR", statusMessage: String(err) });
      throw err;
    });
    batchSpan.end({ output: batch.id });

    const createDesignSpan = trace.span({ name: "create-design-rows" });
    const designs = await Promise.all(
      concepts.map((c) =>
        prisma.design.create({
          data: {
            batchId: batch.id,
            title: c.title,
            phrase: c.phrase,
            visualConcept: c.visualConcept,
            vibe: c.vibe ?? null,
            blurb: c.blurb ?? null,
            style,
            designPrompt: prompts.designImage(c),
            productPrompt: `[mockup composite of clean design on ${resolvedColor} tee]`,
            designImagePath: "",
            productImagePath: "",
            category: resolvedCategory,
            variantColor: resolvedColor,
            status: "generating",
          },
        })
      )
    ).catch((err) => {
      createDesignSpan.end({ level: "ERROR", statusMessage: String(err) });
      throw err;
    });
    createDesignSpan.end({ output: designs.map((d) => d.id) });

    trace.update({
      output: { batchId: batch.id, designCount: designs.length },
    });

    logger.info(`[Stage 1] Wrote ${designs.length} concepts, artwork pending`, {
      traceId,
      batchId: batch.id,
      count: designs.length,
    });

    return NextResponse.json({
      batchId: batch.id,
      keyword,
      designs,
      options: getProvider().options(resolvedCategory),
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
