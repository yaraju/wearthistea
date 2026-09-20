import { NextResponse } from "next/server";
import { z } from "zod";
import { runFixStep, abandonFixStep, judgeVerdictSchema } from "@/lib/validation-chain";
import { isFinalDelivery, QUEUE_MAX_ATTEMPTS } from "@/lib/task-retry";
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
// calls src/lib/design-fix.ts's applyProgrammaticFix() (issue #14) to
// actually relabel/invert-ink/rerun-bg-removal the design. A genuine fix
// failure still makes this route return 502 so Cloud Tasks retries per the
// design-fix queue's backoff config — see design-fix.ts's doc comment for
// why applyProgrammaticFix() throws (rather than silently no-op'ing) on
// failure.
// 5xx so the queue retries — except on the final delivery, where the row is
// ended terminally (issue #33) and 200 acks so it isn't left "regenerating".
async function failOrRetry(req: Request, designId: string, error: string) {
  if (isFinalDelivery(req, QUEUE_MAX_ATTEMPTS.fix)) {
    await abandonFixStep(designId, error).catch((e) =>
      logger.error("[fix-design task] Failed to abandon row on final attempt", { designId, error: e })
    );
    return NextResponse.json({ ok: false, error, final: true }, { status: 200 });
  }
  return NextResponse.json({ ok: false, error }, { status: 502 });
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
    const result = await runFixStep(designId, verdict);

    if (!result.ok) {
      logger.error(`[fix-design task] applyProgrammaticFix failed for design ${designId}: ${result.error}`, {
        designId,
      });
      return failOrRetry(req, designId, result.error ?? "Fix failed.");
    }

    if (!result.skipped) {
      // Re-enqueue judge — the fix itself only mutates the row and returns;
      // runFixStep already handed the row back to "pending". A redelivered
      // fix task would see "pending" and no-op (and re-applying a fix like
      // invert-ink isn't safe), so a queue-level retry can't help here:
      // retry the enqueue inline, and if it still fails leave the row at
      // "pending" for the stuck-row sweeper (src/lib/validation-sweeper.ts),
      // which re-judges it — instead of the old swallow-and-forget (#33).
      let queued = false;
      for (let attempt = 1; attempt <= 3 && !queued; attempt++) {
        try {
          queued = await enqueueDesignJudge(designId);
          if (!queued) break; // queue not configured — retrying won't help
        } catch (err) {
          logger.error(`[fix-design task] Failed to re-enqueue judge task after fix (attempt ${attempt})`, {
            designId,
            error: err,
          });
        }
      }
      if (!queued) {
        logger.error("[fix-design task] Judge not enqueued after fix — row left at pending for the sweeper", {
          designId,
        });
      }
    }

    return NextResponse.json({ ok: true, skipped: Boolean(result.skipped) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Fix task failed.";
    logger.error(`[fix-design task] Unexpected failure for design ${designId}: ${message}`, { designId, error: err });
    return failOrRetry(req, designId, message);
  }
}
