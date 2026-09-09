import { NextResponse } from "next/server";
import { z } from "zod";
import { realizeDesign } from "@/lib/realize";
import { langfuse, getTraceId } from "@/lib/langfuse";
import { logger } from "@/lib/logger";
import { friendlyError } from "@/lib/error-messages";
import { checkGenerateRateLimit, recordGenerateUsage } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  designId: z.string(),
});

export async function POST(req: Request) {
  // Shares the same budget pool as /api/generate — this endpoint re-renders
  // the (uncapped-cost) high-res image on every call, so it's at least as
  // exposed to abuse as the text-only concept step.
  const rateLimit = await checkGenerateRateLimit(req);
  if (!rateLimit.ok) {
    return NextResponse.json(
      { error: "You've hit the free-generation limit for now — try again in a bit." },
      { status: 429 }
    );
  }

  let body;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Design ID is required." }, { status: 400 });
  }

  const { designId } = body;

  const traceId = getTraceId(req);
  const trace = langfuse.trace({
    name: "realize-api",
    id: traceId,
    input: body,
  });

  logger.info(`[Stage 2] Starting realization for design: ${designId}`, {
    traceId,
    designId,
  });

  try {
    const realized = await realizeDesign(designId, trace);

    // realizeDesign() catches its own Gemini errors rather than throwing —
    // Gemini's own 429/503 (its quota/capacity, not ours) isn't the caller's
    // fault, so it shouldn't spend their free-generation budget either.
    const transientFailure = realized.status === "failed" && Boolean(realized.transientProviderError);
    if (!transientFailure) await recordGenerateUsage(rateLimit);

    trace.update({ output: { designId, status: realized.status } });

    if (transientFailure) {
      logger.error(`[Stage 2] Realization hit provider capacity for design ${designId}`, {
        traceId,
        designId,
      });
      return NextResponse.json(
        { error: "Our design engine is swamped right now — try again in a moment." },
        { status: 503 }
      );
    }

    logger.info(`[Stage 2] Successfully realized design: ${designId}`, {
      traceId,
      designId,
      status: realized.status,
    });

    return NextResponse.json({
      success: true,
      design: realized,
    });
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : "Realization failed.";
    const message = friendlyError(rawMessage);
    trace.update({
      tags: ["error"],
      output: { error: rawMessage },
    });
    logger.error(`[Stage 2] Realization failed for design ${designId}: ${rawMessage}`, {
      traceId,
      designId,
      error: err,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
