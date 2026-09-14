import { NextResponse } from "next/server";
import { z } from "zod";
import { runFixStep, judgeVerdictSchema } from "@/lib/validation-chain";
import { enqueueDesignJudge } from "@/lib/tasks";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 120;

const Body = z.object({
  designId: z.string().min(1),
  verdict: judgeVerdictSchema,
});

// Called by Cloud Tasks (enqueueDesignFix, from judge-design's routing
// decision) — same shared-secret auth as every other /api/tasks/* route.
// Delegates to src/lib/validation-chain.ts's runFixStep(), which in turn
// calls src/lib/design-fix.ts's applyProgrammaticFix() — issue #14's stub,
// not implemented yet (throws). Until #14 lands, this route will keep
// returning 502 and Cloud Tasks will keep retrying per the design-fix
// queue's backoff config — that's expected; see design-fix.ts's doc
// comment for why this is a deliberate throw rather than a silent no-op.
export async function POST(req: Request) {
  const secret = req.headers.get("x-task-secret");
  if (!process.env.TASKS_SHARED_SECRET || secret !== process.env.TASKS_SHARED_SECRET) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Malformed task payload." }, { status: 400 });
  }

  const { designId, verdict } = body;

  try {
    const result = await runFixStep(designId, verdict);

    if (!result.ok) {
      logger.error(`[fix-design task] applyProgrammaticFix failed for design ${designId}: ${result.error}`, {
        designId,
      });
      return NextResponse.json({ ok: false, error: result.error }, { status: 502 });
    }

    if (!result.skipped) {
      // Re-enqueue judge — the fix itself only mutates the row and returns;
      // it never advances validationStatus or re-runs the judge itself.
      await enqueueDesignJudge(designId).catch((err) => {
        logger.error("[fix-design task] Failed to re-enqueue judge task after fix", { designId, error: err });
      });
    }

    return NextResponse.json({ ok: true, skipped: Boolean(result.skipped) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Fix task failed.";
    logger.error(`[fix-design task] Unexpected failure for design ${designId}: ${message}`, { designId, error: err });
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
