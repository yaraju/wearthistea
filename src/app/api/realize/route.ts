import { NextResponse } from "next/server";
import { z } from "zod";
import { realizeDesign } from "@/lib/realize";
import { langfuse, getTraceId } from "@/lib/langfuse";
import { logger } from "@/lib/logger";

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

    trace.update({ output: { designId, status: realized.status } });

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
    const message = err instanceof Error ? err.message : "Realization failed.";
    trace.update({
      tags: ["error"],
      output: { error: message },
    });
    logger.error(`[Stage 2] Realization failed for design ${designId}: ${message}`, {
      traceId,
      designId,
      error: err,
    });
    console.error(`[Stage 2] Failed for design ${designId}:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
