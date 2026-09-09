import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { renderDesignArtwork, isTransientProviderError } from "@/lib/design-render";
import { checkGenerateRateLimit, setRateLimitCookie } from "@/lib/rate-limit";
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

    const updated = await renderDesignArtwork(design, trace, rateLimit);

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
