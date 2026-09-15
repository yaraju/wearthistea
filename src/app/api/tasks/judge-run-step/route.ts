import { NextResponse } from "next/server";
import { z } from "zod";
import { advanceJudgeRun } from "@/lib/judge-run";
import { enqueueJudgeRunStep } from "@/lib/tasks";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  runId: z.string().min(1),
});

// Called by Cloud Tasks (enqueueJudgeRunStep — see /api/admin/judge-runs,
// which enqueues the first step, and this route itself, which re-enqueues
// the next one) — same shared-secret auth as every other /api/tasks/*
// route. Delegates to src/lib/judge-run.ts's advanceJudgeRun() for the
// actual per-design work (issue #19); this route is just auth + payload
// parsing + self-chaining until the run reports done.
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

  const { runId } = body;

  try {
    const result = await advanceJudgeRun(runId);

    if (!result.done) {
      // Re-enqueue immediately for the next design — best-effort: if this
      // fails, the run simply stalls at its current `processed` count
      // (visible to the admin poller as a run that stopped progressing),
      // same degraded-not-corrupted failure mode every other queue in this
      // chain accepts rather than retrying the enqueue itself indefinitely.
      await enqueueJudgeRunStep(runId).catch((err) => {
        logger.error("[judge-run-step task] Failed to enqueue next step", { runId, error: err });
      });
    }

    return NextResponse.json({ ok: true, done: result.done, outcome: result.outcome });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Judge-run step failed.";
    logger.error(`[judge-run-step task] Failed for run ${runId}: ${message}`, { runId, error: err });
    // 5xx so Cloud Tasks retries per the judge-run queue's own backoff
    // config — advanceJudgeRun()'s compare-and-swap on `processed` makes a
    // retry of a step that already landed a safe no-op (see judge-run.ts's
    // JudgeRunStore.advance doc comment), so retrying a step that crashed
    // mid-flight is safe to redrive.
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
