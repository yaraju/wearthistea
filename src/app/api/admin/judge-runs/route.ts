import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, getAdminSession } from "@/lib/auth";
import { createJudgeRun, prismaJudgeRunStore } from "@/lib/judge-run";
import { enqueueJudgeRunStep } from "@/lib/tasks";
import { VALIDATION_STATUSES } from "@/lib/validation-status";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

const MAX_LIMIT = 200;

// Admin control panel for scripts/judge-designs.ts's bulk judge sweep
// (issue #19) — mirrors that script's `--status`/`--limit`/`--apply` flags
// as a form: statusFilter/limit/mode. GET lists recent runs (for the
// landing view); POST starts a new one.
export async function GET(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 50);

  const runs = await prismaJudgeRunStore.findMany(limit);
  return NextResponse.json({ runs: runs.map(serializeRun) });
}

const Body = z.object({
  statusFilter: z.enum(VALIDATION_STATUSES),
  limit: z.number().int().min(1).max(MAX_LIMIT),
  mode: z.enum(["auto", "manual"]),
});

export async function POST(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const session = await getAdminSession(req);

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: "Invalid run parameters.", detail: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }

  const run = await createJudgeRun({
    mode: body.mode,
    statusFilter: body.statusFilter,
    limit: body.limit,
    createdByEmail: session?.email ?? null,
  });

  if (run.status !== "running") {
    // Zero designs matched the scope — nothing to enqueue, already
    // "completed" by createJudgeRun() itself.
    return NextResponse.json({ run: serializeRun(run) });
  }

  const enqueued = await enqueueJudgeRunStep(run.id).catch((err) => {
    logger.error("[judge-runs] Failed to enqueue first step", { runId: run.id, error: err });
    return false;
  });

  if (!enqueued) {
    const failed = await prismaJudgeRunStore.update(run.id, {
      status: "failed",
      error:
        "Cloud Tasks judge-run queue is not configured (CLOUD_TASKS_QUEUE_JUDGE_RUN / SITE_URL / " +
        "TASKS_SHARED_SECRET) — nothing exists to advance this run. Configure the queue (see AGENTS.md / " +
        ".env.example), then start a new run.",
    });
    return NextResponse.json({ run: serializeRun(failed) }, { status: 202 });
  }

  return NextResponse.json({ run: serializeRun(run) });
}

function serializeRun(run: Awaited<ReturnType<typeof prismaJudgeRunStore.findById>>) {
  if (!run) return null;
  return {
    id: run.id,
    mode: run.mode,
    statusFilter: run.statusFilter,
    limit: run.limit,
    status: run.status,
    total: run.total,
    processed: run.processed,
    outcomeCounts: JSON.parse(run.outcomeCounts),
    error: run.error,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    createdByEmail: run.createdByEmail,
  };
}
