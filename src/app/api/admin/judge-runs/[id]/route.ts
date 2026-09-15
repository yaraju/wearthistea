import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { prismaJudgeRunStore, getJudgeRunRubrics, rejectModeChange, type FlaggedDesignEntry } from "@/lib/judge-run";

export const runtime = "nodejs";

// Live-progress poll for one bulk judge run (issue #19) — the admin page
// polls this while a run is "running" (see /api/tasks/judge-run-step, which
// actually advances it). GET-only progress read; see PATCH below for why
// mode can never be changed once the row exists.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;

  const run = await prismaJudgeRunStore.findById(id);
  if (!run) return NextResponse.json({ error: "Run not found." }, { status: 404 });

  const flagged: FlaggedDesignEntry[] = JSON.parse(run.flagged);

  // For every flagged entry without a known sibling yet (a manual-mode
  // entry the admin hasn't clicked "regenerate" on, or clicked but whose
  // background render hasn't finished linking up), do a live lookup —
  // same defaultChildLookup pattern design-versions.ts's
  // getDesignVersionChain() uses — rather than trusting a value this route
  // would otherwise need a separate callback to ever update. An
  // already-known siblingId (an auto-mode entry that created its own
  // sibling synchronously during the run) is never re-queried.
  const flaggedWithLiveSiblings = await Promise.all(
    flagged.map(async (entry) => {
      if (entry.siblingId) {
        const sibling = await prisma.design.findUnique({
          where: { id: entry.siblingId },
          select: { id: true, slug: true, status: true },
        });
        return { ...entry, sibling };
      }
      const sibling = await prisma.design.findUnique({
        where: { regeneratedFromDesignId: entry.designId },
        select: { id: true, slug: true, status: true },
      });
      return { ...entry, sibling, siblingId: sibling?.id };
    })
  );

  return NextResponse.json({
    run: {
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
    },
    rubrics: getJudgeRunRubrics(run),
    flagged: flaggedWithLiveSiblings,
  });
}

const PatchBody = z.object({
  mode: z.enum(["auto", "manual"]),
});

// A run's mode is chosen once, at start time, and frozen for its entire
// duration (issue #19's explicit requirement) — there is deliberately no
// code path anywhere that updates JudgeRun.mode after createJudgeRun()
// writes it. This route exists only to make that guarantee an explicit,
// testable API contract (rather than "just don't build a route for it" —
// see scripts/test-judge-run.ts) and to give a clear, on-brand error if a
// client ever tries: any PATCH against an existing run's mode is rejected,
// unconditionally, whether or not the run has finished.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const { id } = await ctx.params;

  let body: z.infer<typeof PatchBody>;
  try {
    body = PatchBody.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid mode value." }, { status: 400 });
  }
  void body;

  const run = await prismaJudgeRunStore.findById(id);
  if (!run) return NextResponse.json({ error: "Run not found." }, { status: 404 });

  const rejection = rejectModeChange(run);
  return NextResponse.json({ error: rejection.error, mode: rejection.mode }, { status: rejection.status });
}
