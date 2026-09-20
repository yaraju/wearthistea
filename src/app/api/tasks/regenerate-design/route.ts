import { NextResponse } from "next/server";
import { z } from "zod";
import { runRegenerateStep, abandonRegenerateStep, judgeVerdictSchema } from "@/lib/validation-chain";
import { enqueueDesignJudge } from "@/lib/tasks";
import { isFinalDelivery, QUEUE_MAX_ATTEMPTS } from "@/lib/task-retry";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  designId: z.string().min(1),
  verdict: judgeVerdictSchema,
});

// Called by Cloud Tasks (enqueueDesignRegenerate, from judge-design's
// routing decision) — same shared-secret auth as every other
// /api/tasks/* route. Delegates to src/lib/validation-chain.ts's
// runRegenerateStep(), which creates a fresh sibling Design (reusing
// design-judge-bulk.ts's flagAndTriggerStuckDesign() /
// /api/admin/designs/[id]/regenerate/route.ts's sibling-creation
// precedent — see that function's doc comment), renders it for real, marks
// the SOURCE design "superseded", and hands back the sibling's id to
// re-enqueue judge against. The sibling's rendered artwork (issue #15) is a
// TARGETED image-to-image edit of the source's current art — the source's
// concept text (src/lib/design-regenerate.ts's buildRegenerationConcept())
// stays a deliberate passthrough, while buildRegenerationEdit() turns the
// judge's regenerationPrompt into the edit instruction actually applied via
// gemini.ts's renderConceptArtFix().
async function failOrRetry(req: Request, designId: string, error: string, siblingId?: string) {
  if (isFinalDelivery(req, QUEUE_MAX_ATTEMPTS.regenerate)) {
    await abandonRegenerateStep(designId, error).catch((e) =>
      logger.error("[regenerate-design task] Failed to abandon lineage on final attempt", { designId, error: e })
    );
    return NextResponse.json({ ok: false, error, siblingId, final: true }, { status: 200 });
  }
  return NextResponse.json({ ok: false, error, siblingId }, { status: 502 });
}

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
    const result = await runRegenerateStep(designId, verdict);

    if (!result.ok) {
      logger.error(`[regenerate-design task] Sibling render failed for design ${designId}: ${result.error}`, {
        designId,
        siblingId: result.siblingId,
      });
      // 5xx so Cloud Tasks retries — runRegenerateStep() is idempotent
      // against a retry (it reuses the already-created sibling via
      // findByRegeneratedFrom rather than erroring on the @unique
      // constraint or duplicating it). On the FINAL delivery (issue #33) end
      // the lineage terminally instead of leaving the sibling "pending".
      return failOrRetry(req, designId, result.error ?? "Sibling render failed.", result.siblingId);
    }

    if (result.judgeTargetId) {
      let queued = false;
      try {
        queued = await enqueueDesignJudge(result.judgeTargetId);
      } catch (err) {
        logger.error("[regenerate-design task] Failed to enqueue judge task for sibling", {
          designId,
          siblingId: result.judgeTargetId,
          error: err,
        });
      }
      // Issue #33: this used to be swallowed as a 200, orphaning the sibling
      // at "pending". A redelivery re-finds the sibling (idempotent) and
      // re-enqueues; if the final delivery still cannot, the stuck-row
      // sweeper (src/lib/validation-sweeper.ts) re-judges it.
      if (!queued && !isFinalDelivery(req, QUEUE_MAX_ATTEMPTS.regenerate)) {
        return NextResponse.json(
          { ok: false, error: "Failed to enqueue judge.", siblingId: result.siblingId },
          { status: 502 }
        );
      }
    }

    return NextResponse.json({ ok: true, skipped: Boolean(result.skipped), siblingId: result.siblingId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Regenerate task failed.";
    logger.error(`[regenerate-design task] Unexpected failure for design ${designId}: ${message}`, {
      designId,
      error: err,
    });
    return failOrRetry(req, designId, message);
  }
}
