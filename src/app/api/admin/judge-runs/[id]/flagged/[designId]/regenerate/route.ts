import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { prismaJudgeRunStore, markDesignRegenerating, prepareFlaggedRegeneration } from "@/lib/judge-run";
import { enqueueDesignRegenerate } from "@/lib/tasks";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

/**
 * Manual-mode's per-design "regenerate" action (issue #19's scope: "flagged
 * designs get an explicit per-design 'regenerate' action instead of being
 * auto-fixed — reuses the sibling-creation path, just admin-triggered per
 * item instead of automatic"). The reused path is deliberately tasks.ts's
 * existing enqueueDesignRegenerate() -> /api/tasks/regenerate-design ->
 * runRegenerateStep() (issue #13/#15) — the SAME sibling-creation/render
 * mechanics an "auto" mode run's own advanceJudgeRun() step uses via
 * judge-designs-runner.ts's regenerateDesignSibling() — routed through the
 * Cloud Tasks queue here (rather than judge-designs-runner.ts's synchronous
 * regenerateDesignSibling(), which the auto-mode task-driven step can call
 * directly since IT already runs inside a Cloud Tasks task with a generous
 * dispatch deadline) because THIS route is invoked directly from the
 * browser and must return well under the ~60s Firebase Hosting proxy
 * timeout — the real Gemini render happens after this responds, same
 * two-stage split as every other admin/generation action in this repo.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; designId: string }> }) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const { id: runId, designId } = await ctx.params;

  const run = await prismaJudgeRunStore.findById(runId);
  if (!run) return NextResponse.json({ error: "Run not found." }, { status: 404 });

  const prepared = prepareFlaggedRegeneration(run, designId);
  if (!prepared.ok) {
    return NextResponse.json({ error: prepared.error }, { status: prepared.status });
  }

  const design = await prisma.design.findUnique({ where: { id: designId } });
  if (!design) return NextResponse.json({ error: "Design not found." }, { status: 404 });

  // Live idempotency check (belt-and-suspenders alongside
  // prepareFlaggedRegeneration's own check against the run's persisted
  // bookkeeping, which — for a manual-mode entry — never gets a siblingId
  // written back into it; see judge-run.ts's FlaggedDesignEntry doc
  // comment): a sibling already existing, or the source already mid-flight
  // toward one, both mean a prior click already handled this design.
  const existingSibling = await prisma.design.findUnique({ where: { regeneratedFromDesignId: designId } });
  if (existingSibling) {
    return NextResponse.json(
      { error: `Already regenerated (sibling ${existingSibling.id}).` },
      { status: 409 }
    );
  }
  if (design.validationStatus === "regenerating") {
    return NextResponse.json({ error: "Regeneration is already in progress for this design." }, { status: 409 });
  }

  await markDesignRegenerating(design, prepared.entry.verdict);

  const enqueued = await enqueueDesignRegenerate(designId, prepared.entry.verdict).catch((err) => {
    logger.error("[judge-runs flagged regenerate] Failed to enqueue regenerate task", { runId, designId, error: err });
    return false;
  });

  if (!enqueued) {
    return NextResponse.json(
      {
        error:
          "Cloud Tasks regenerate queue is not configured (CLOUD_TASKS_QUEUE_REGENERATE / SITE_URL / " +
          "TASKS_SHARED_SECRET) — the design was marked \"regenerating\" but nothing exists to advance it. " +
          "Configure the queue, then retry.",
      },
      { status: 503 }
    );
  }

  return NextResponse.json({ ok: true, message: "Regeneration queued — refresh this run shortly to see the sibling." });
}
