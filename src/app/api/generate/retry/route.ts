import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { renderConceptArt, isTransientProviderError } from "@/lib/gemini";
import type { Concept } from "@/config/prompts";
import { compositeOnTee } from "@/lib/mockup";
import { saveImage, hasDurableStorage } from "@/lib/storage";
import { settings } from "@/config/settings";
import { checkGenerateRateLimit, recordGenerateUsage, setRateLimitCookie } from "@/lib/rate-limit";
import { enqueuePrintroveProducts } from "@/lib/tasks";
import { logger } from "@/lib/logger";
import { langfuse, getTraceId } from "@/lib/langfuse";
import { friendlyError } from "@/lib/error-messages";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  designId: z.string(),
});

export async function POST(req: Request) {
  // Same budget pool as /api/generate and /api/realize — this route also
  // triggers a full paid image render.
  const rateLimit = await checkGenerateRateLimit(req);
  if (!rateLimit.ok) {
    const res = NextResponse.json(
      { error: "You've hit the free-generation limit for now — try again in a bit." },
      { status: 429 }
    );
    setRateLimitCookie(res, rateLimit);
    return res;
  }

  let body;
  try {
    body = Body.parse(await req.json());
  } catch {
    const res = NextResponse.json({ error: "Missing designId." }, { status: 400 });
    setRateLimitCookie(res, rateLimit);
    return res;
  }

  const { designId } = body;

  const traceId = getTraceId(req);
  const trace = langfuse.trace({
    name: "generate-retry-api",
    id: traceId,
    input: body,
  });

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
        // Only needed as a lost-file fallback on ephemeral local disk — once
        // GCS is configured, saveImage() above already either durably
        // persisted this or threw, so storing a second copy here would just
        // be permanent, ever-growing database bloat for no benefit.
        designImageData: hasDurableStorage ? null : designB64,
        status: "generated",
        errorMessage: null,
      },
    });

    // Brew Printrove preview products for every enabled category now, so
    // they're usually ready by the time a customer picks this design.
    // Awaited (not fire-and-forget) — Cloud Run can throttle/suspend CPU
    // once a response is sent, so a detached promise here isn't reliably
    // guaranteed to finish (same reasoning as the awaited enqueueEmail calls
    // elsewhere). Never fails the response either way — the artwork already
    // rendered successfully, which is what the customer is waiting on; the
    // pick-time endpoint falls back to creating these on demand regardless.
    try {
      await enqueuePrintroveProducts(designId);
    } catch (err) {
      logger.error("[generate/retry] Failed to enqueue Printrove preview creation", {
        designId,
        error: err,
      });
    }

    trace.update({ output: { designId, status: updated.status } });
    const res = NextResponse.json({ design: updated });
    setRateLimitCookie(res, rateLimit);
    return res;
  } catch (err) {
    const transient = isTransientProviderError(err);
    const rawMessage = err instanceof Error ? err.message : "Retry failed.";
    const message = transient
      ? "Our design engine is swamped right now — try again in a moment."
      : friendlyError(rawMessage);
    trace.update({
      tags: ["error"],
      output: { error: rawMessage },
    });
    logger.error(`[generate/retry] Render failed for design ${designId}: ${rawMessage}`, {
      traceId,
      designId,
      error: err,
    });
    // Best-effort: this route is now also the initial-render path (not just
    // manual retries), so a design left at "generating" forever after a
    // failure would look stuck rather than failed on a page reload.
    await prisma.design
      .update({ where: { id: designId }, data: { status: "failed", errorMessage: rawMessage } })
      .catch((updateErr) => {
        logger.error(`[generate/retry] Failed to persist failure status for design ${designId}`, {
          traceId,
          designId,
          error: updateErr,
        });
      });
    const res = NextResponse.json({ error: message }, { status: transient ? 503 : 500 });
    setRateLimitCookie(res, rateLimit);
    return res;
  }
}
