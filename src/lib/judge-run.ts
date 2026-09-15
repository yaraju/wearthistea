/**
 * Bulk judge-run tracking (issue #19) — the admin-UI counterpart to
 * scripts/judge-designs.ts (issue #18): same scope (a `validationStatus`
 * filter + a limit, same ordering: createdAt asc, id asc) and the exact same
 * per-design decision core (src/lib/judge-designs-runner.ts's
 * judgeOneDesign()/computeExclusion() — never forked, only called), but
 * driven by a persisted JudgeRun row instead of a CLI process, so an admin
 * can start a run and poll its live progress instead of shelling in.
 *
 * Split into small steps (createJudgeRun() then repeated advanceJudgeRun()
 * calls, one Design per call) rather than one big loop, because a bulk sweep
 * over more than a handful of designs (each a real Gemini call, sometimes
 * followed by a full sibling render) would run well past the ~60s Firebase
 * Hosting proxy timeout if driven synchronously inside a single admin
 * request — see /api/generate's own two-stage split for the exact same
 * reasoning. The actual "keep calling advanceJudgeRun until done" driver
 * lives in /api/tasks/judge-run-step (a Cloud Tasks self-chaining task,
 * mirroring the judge/fix/regenerate chain's precedent, issue #13) — this
 * module only implements the per-step logic, kept side-effect-injectable
 * (no direct `prisma` import at module scope) so scripts/test-judge-run.ts
 * can exercise it against an in-memory fake store, at zero cost and zero
 * risk to the real (shared prod) DB — same pattern as validation-chain.ts /
 * judge-designs-runner.ts's own tests.
 *
 * ── Mode is frozen for the life of a run ────────────────────────────────
 * `mode` ("auto" | "manual") is set once, at createJudgeRun() time, and
 * NEVER updated afterward — no route mutates JudgeRun.mode once the row
 * exists (PATCH /api/admin/judge-runs/[id] always 409s, see that route).
 * advanceJudgeRun() reinforces this at the data layer too: it always derives
 * `apply` (judgeOneDesign()'s auto-fix switch) from the PERSISTED run row it
 * just loaded, never from anything a caller passes in — so even a
 * maliciously/buggily mismatched task payload can't flip a run's behavior
 * mid-flight (see scripts/test-judge-run.ts's "payload can't override the
 * persisted mode" case).
 *
 * ── Why a full id-list snapshot, not a live re-query per step ───────────
 * scripts/judge-designs.ts's own tie-breaker comment already flags this
 * class of bug: `where: {validationStatus: status}, take: limit` is a
 * MOVING window once you start writing — in "auto" mode, processing a
 * design flips its validationStatus OUT of the very filter that selected it
 * (validated/regenerating/superseded), so a per-step re-query would skip
 * rows, reprocess rows, or both, and `total` would drift out from under the
 * progress bar. createJudgeRun() snapshots the exact ids once, in the same
 * stable order the CLI script uses, and every step just indexes into that
 * frozen list.
 */
import type { Design, Prisma } from "@prisma/client";
import type { JudgeVerdict } from "./design-judge";
import {
  computeExclusion,
  judgeOneDesign,
  markDesignRegenerating,
  type ExclusionResult,
  type JudgeOneDeps,
  type JudgeOneOutcome,
} from "./judge-designs-runner";
import {
  buildRubricReport,
  type BulkDesignVerdict,
  type RubricResult,
} from "./design-judge-bulk";

export type JudgeRunMode = "auto" | "manual";
export type JudgeRunStatus = "running" | "completed" | "failed";

/** The five named rubrics (#17) plus the run's own scope — mirrors
 * scripts/judge-designs.ts's `--status`/`--limit` flags. */
export interface JudgeRunScope {
  statusFilter: string;
  limit: number;
}

/** One design surfaced for admin attention — either excluded from auto-fix
 * (either mode: attached to a placed Order or a live/fulfilled
 * DesignProduct, per judge-designs-runner.ts's computeExclusion()), or, in
 * "manual" mode only, every judge failure at all (since manual mode never
 * auto-fixes anything — see the mode doc comment above). */
export interface FlaggedDesignEntry {
  designId: string;
  title: string;
  outcome: JudgeOneOutcome;
  detail: string;
  /** The full judge verdict, stored so a LATER manual "regenerate" click
   * (POST /api/admin/judge-runs/[id]/flagged/[designId]/regenerate) can
   * reuse it via regenerateDesignSibling() instead of spending a second
   * Gemini call to reconstruct it — see judge-designs-runner.ts's
   * JudgeOneResult.judgeVerdict doc comment. */
  verdict: JudgeVerdict;
  /** Set immediately for an auto-mode entry that already created its own
   * sibling (outcome "sibling-created"/"sibling-created-render-failed").
   * Left undefined for a manual-mode "would-create-sibling"/
   * "flagged-for-review" entry until an admin actually clicks regenerate —
   * callers should re-resolve a live sibling via regeneratedFromDesignId
   * rather than trusting this field to always be current (see
   * getJudgeRunProgress() in the GET route, which does exactly that). */
  siblingId?: string;
}

export interface JudgeRunRecord {
  id: string;
  mode: JudgeRunMode;
  statusFilter: string;
  limit: number;
  status: JudgeRunStatus;
  designIds: string; // JSON string[]
  total: number;
  processed: number;
  outcomeCounts: string; // JSON Record<string, number>
  verdicts: string; // JSON BulkDesignVerdict[]
  flagged: string; // JSON FlaggedDesignEntry[]
  error: string | null;
  startedAt: Date;
  completedAt: Date | null;
  createdByEmail: string | null;
}

// ─────────────────────────────────────────────────────────────────────────
// JudgeRunStore — the one seam every function below goes through instead of
// importing `prisma` directly, exactly mirroring validation-chain.ts's
// DesignStore split (issue #13) / judge-designs-runner.ts's DesignStore
// reuse (issue #18). prismaJudgeRunStore is the real implementation every
// route handler uses by default; scripts/test-judge-run.ts substitutes an
// in-memory fake.
// ─────────────────────────────────────────────────────────────────────────

export interface JudgeRunStore {
  create(data: Omit<JudgeRunRecord, "id">): Promise<JudgeRunRecord>;
  findById(id: string): Promise<JudgeRunRecord | null>;
  findMany(limit: number): Promise<JudgeRunRecord[]>;
  /** Compare-and-swap on `processed` — the run-level analogue of
   * DesignStore.claim(): writes `patch` only if the row's CURRENT
   * `processed` still equals `expectedProcessed`, so a duplicate Cloud
   * Tasks delivery of the same step (at-least-once delivery is the whole
   * reason every other task route in this repo is written idempotently —
   * see validation-chain.ts's top doc comment) can't double-process the
   * same design or double-count it. Returns null (a no-op the caller
   * should treat as "someone else already advanced this run") on mismatch
   * or a missing row. */
  advance(
    id: string,
    expectedProcessed: number,
    patch: Partial<Omit<JudgeRunRecord, "id">>
  ): Promise<JudgeRunRecord | null>;
  /** Plain (non-CAS) update — used only for the creation-time failure path
   * (queue not configured) and for closing out a zero-design run, neither
   * of which race with a step. */
  update(id: string, patch: Partial<Omit<JudgeRunRecord, "id">>): Promise<JudgeRunRecord>;
}

function toRecord(row: {
  id: string;
  mode: string;
  statusFilter: string;
  limit: number;
  status: string;
  designIds: string;
  total: number;
  processed: number;
  outcomeCounts: string;
  verdicts: string;
  flagged: string;
  error: string | null;
  startedAt: Date;
  completedAt: Date | null;
  createdByEmail: string | null;
}): JudgeRunRecord {
  return { ...row, mode: row.mode as JudgeRunMode, status: row.status as JudgeRunStatus };
}

export const prismaJudgeRunStore: JudgeRunStore = {
  async create(data) {
    const { prisma } = await import("./prisma");
    const row = await prisma.judgeRun.create({ data: data as Prisma.JudgeRunUncheckedCreateInput });
    return toRecord(row);
  },
  async findById(id) {
    const { prisma } = await import("./prisma");
    const row = await prisma.judgeRun.findUnique({ where: { id } });
    return row ? toRecord(row) : null;
  },
  async findMany(limit) {
    const { prisma } = await import("./prisma");
    const rows = await prisma.judgeRun.findMany({ orderBy: { startedAt: "desc" }, take: limit });
    return rows.map(toRecord);
  },
  async advance(id, expectedProcessed, patch) {
    const { prisma } = await import("./prisma");
    const result = await prisma.judgeRun.updateMany({
      where: { id, processed: expectedProcessed },
      data: patch as Prisma.JudgeRunUncheckedUpdateManyInput,
    });
    if (result.count === 0) return null;
    const row = await prisma.judgeRun.findUnique({ where: { id } });
    return row ? toRecord(row) : null;
  },
  async update(id, patch) {
    const { prisma } = await import("./prisma");
    const row = await prisma.judgeRun.update({ where: { id }, data: patch as Prisma.JudgeRunUncheckedUpdateInput });
    return toRecord(row);
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Scoping — same query shape as scripts/judge-designs.ts's `designs` lookup.
// ─────────────────────────────────────────────────────────────────────────

/** A Design row plus the two relations judgeOneDesign()'s exclusion check
 * needs — same `include` shape scripts/judge-designs.ts uses. */
export type ScopedDesign = Design & {
  orders: { status: string }[];
  designProducts: { status: string; approvalStatus: string }[];
};

export async function scopeDesignIds(statusFilter: string, limit: number): Promise<string[]> {
  const { prisma } = await import("./prisma");
  const rows = await prisma.design.findMany({
    where: { validationStatus: statusFilter },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit,
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

async function defaultLoadDesign(id: string): Promise<ScopedDesign | null> {
  const { prisma } = await import("./prisma");
  return prisma.design.findUnique({
    where: { id },
    include: {
      orders: { select: { status: true } },
      designProducts: { select: { status: true, approvalStatus: true } },
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Create
// ─────────────────────────────────────────────────────────────────────────

export interface CreateJudgeRunParams {
  mode: JudgeRunMode;
  statusFilter: string;
  limit: number;
  createdByEmail?: string | null;
}

export interface CreateJudgeRunDeps {
  store?: JudgeRunStore;
  scopeFn?: (statusFilter: string, limit: number) => Promise<string[]>;
  now?: Date;
}

/**
 * Snapshots the run's scope (see the module doc comment on why this must be
 * a one-time snapshot, not a live filter) and persists a JudgeRun row.
 * A zero-design scope closes the run out as "completed" immediately (there's
 * nothing for a caller to enqueue a first step for) rather than leaving a
 * "running" row with total=0 forever.
 *
 * Never triggers any Design judging itself — the caller (the admin route)
 * is responsible for kicking off the first advanceJudgeRun() step (normally
 * via enqueueJudgeRunStep(), issue #19's Cloud Tasks queue) once this
 * returns, exactly the same "create fast, do the slow part async" split
 * every other admin/generation route in this repo already uses.
 */
export async function createJudgeRun(
  params: CreateJudgeRunParams,
  deps: CreateJudgeRunDeps = {}
): Promise<JudgeRunRecord> {
  const store = deps.store ?? prismaJudgeRunStore;
  const scopeFn = deps.scopeFn ?? scopeDesignIds;
  const now = deps.now ?? new Date();

  const ids = await scopeFn(params.statusFilter, params.limit);
  const done = ids.length === 0;

  return store.create({
    mode: params.mode,
    statusFilter: params.statusFilter,
    limit: params.limit,
    status: done ? "completed" : "running",
    designIds: JSON.stringify(ids),
    total: ids.length,
    processed: 0,
    outcomeCounts: "{}",
    verdicts: "[]",
    flagged: "[]",
    error: null,
    startedAt: now,
    completedAt: done ? now : null,
    createdByEmail: params.createdByEmail ?? null,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Advance — process exactly one design from the run's frozen scope.
// ─────────────────────────────────────────────────────────────────────────

export interface AdvanceJudgeRunDeps {
  store?: JudgeRunStore;
  loadDesign?: (id: string) => Promise<ScopedDesign | null>;
  /** Passed straight through to judgeOneDesign() — lets tests (and the real
   * Cloud Tasks route, which needs its own isolated rate-limit bucket, same
   * reasoning as scripts/judge-designs.ts's scriptRenderFn) inject
   * judgeFn/auditFn/styleFn/renderFn/canAudit without this module needing
   * to know their shapes. */
  judgeDeps?: JudgeOneDeps;
}

export interface AdvanceJudgeRunResult {
  /** True once the run has left "running" (just now, or already before this
   * call — a duplicate/late step is a safe no-op that reports done: true
   * without processing anything). False means the caller should schedule
   * another advanceJudgeRun() call for the next design. */
  done: boolean;
  processedDesignId?: string;
  outcome?: JudgeOneOutcome;
}

function needsAdminAttention(outcome: JudgeOneOutcome): boolean {
  return (
    outcome === "flagged-for-review" ||
    outcome === "would-create-sibling" ||
    outcome === "sibling-created-render-failed"
  );
}

export async function advanceJudgeRun(
  runId: string,
  deps: AdvanceJudgeRunDeps = {}
): Promise<AdvanceJudgeRunResult> {
  const store = deps.store ?? prismaJudgeRunStore;
  const loadDesign = deps.loadDesign ?? defaultLoadDesign;

  const run = await store.findById(runId);
  if (!run) return { done: true };
  // Already finished (completed/failed) — a duplicate Cloud Tasks delivery
  // arriving after the run closed out is a safe no-op, never re-opens it.
  if (run.status !== "running") return { done: true };

  const ids: string[] = JSON.parse(run.designIds);

  if (run.processed >= run.total) {
    await store.advance(runId, run.processed, { status: "completed", completedAt: new Date() });
    return { done: true };
  }

  const designId = ids[run.processed];
  const design = await loadDesign(designId);

  if (!design) {
    // Deleted (or otherwise vanished) since this run's scope was snapshotted
    // — nothing to judge, but it still counts toward processed so the run
    // terminates instead of stalling on a row that will never resolve.
    const nextProcessed = run.processed + 1;
    const done = nextProcessed >= run.total;
    const updated = await store.advance(runId, run.processed, {
      processed: nextProcessed,
      status: done ? "completed" : "running",
      completedAt: done ? new Date() : null,
    });
    if (!updated) return { done: true }; // lost the race to a duplicate delivery
    return { done, processedDesignId: designId };
  }

  const exclusion: ExclusionResult = computeExclusion(design.orders, design.designProducts);
  // `apply` is ALWAYS derived from the run row this function just loaded —
  // see the module doc comment on why nothing else may ever influence it.
  const apply = run.mode === "auto";

  const result = await judgeOneDesign(design, exclusion, apply, deps.judgeDeps ?? {});

  const verdicts: BulkDesignVerdict[] = JSON.parse(run.verdicts);
  verdicts.push(result.verdict);

  const outcomeCounts: Record<string, number> = JSON.parse(run.outcomeCounts);
  outcomeCounts[result.outcome] = (outcomeCounts[result.outcome] ?? 0) + 1;

  const flagged: FlaggedDesignEntry[] = JSON.parse(run.flagged);
  if (needsAdminAttention(result.outcome) && result.judgeVerdict) {
    flagged.push({
      designId: design.id,
      title: design.title,
      outcome: result.outcome,
      detail: result.detail,
      verdict: result.judgeVerdict,
      siblingId: result.siblingId,
    });
  }

  const nextProcessed = run.processed + 1;
  const done = nextProcessed >= run.total;
  const updated = await store.advance(runId, run.processed, {
    processed: nextProcessed,
    outcomeCounts: JSON.stringify(outcomeCounts),
    verdicts: JSON.stringify(verdicts),
    flagged: JSON.stringify(flagged),
    status: done ? "completed" : "running",
    completedAt: done ? new Date() : null,
  });
  if (!updated) return { done: true }; // lost the race to a duplicate delivery

  return { done, processedDesignId: designId, outcome: result.outcome };
}

/** Recomputes the five named rubrics (#17) from a run's accumulated
 * verdicts — never stored redundantly, always derived, so it can never
 * drift from design-judge-bulk.ts's own rubric math (the same function the
 * CLI script's own SUMMARY block calls). */
export function getJudgeRunRubrics(run: Pick<JudgeRunRecord, "verdicts">): RubricResult[] {
  const verdicts: BulkDesignVerdict[] = JSON.parse(run.verdicts);
  return buildRubricReport(verdicts);
}

// ─────────────────────────────────────────────────────────────────────────
// Manual-mode per-design regenerate action.
// ─────────────────────────────────────────────────────────────────────────

/**
 * The entire body of PATCH /api/admin/judge-runs/[id] — pulled out as a
 * pure function (issue #19's own testable-contract precedent: judge-
 * designs-runner.ts's computeExclusion(), design-judge-bulk.ts's
 * buildRubricReport(), etc.) so scripts/test-judge-run.ts can assert the
 * "mode is frozen once a run has started" guarantee without needing an
 * authenticated admin session to drive the real route (requireAdmin() would
 * 401 first in a test with no real Firebase session — see that test file's
 * top comment). Notably takes no "requested mode" argument at all: there is
 * structurally no way for this function to honor a change, which is the
 * point.
 */
export function rejectModeChange(run: Pick<JudgeRunRecord, "mode">): { status: 409; error: string; mode: JudgeRunMode } {
  return {
    status: 409,
    error: "A run's auto/manual mode is frozen once the run has started and can never be changed — start a new run instead.",
    mode: run.mode,
  };
}

export type PrepareRegenerationResult =
  | { ok: true; entry: FlaggedDesignEntry }
  | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * Pure precondition check for POST /api/admin/judge-runs/[id]/flagged/
 * [designId]/regenerate — kept separate from the actual DB write + Cloud
 * Tasks enqueue (both real side effects the route performs itself) so the
 * validation logic (manual mode only, must be a real flagged entry, can't
 * double-trigger) is unit-testable without a fake queue.
 */
export function prepareFlaggedRegeneration(
  run: Pick<JudgeRunRecord, "mode" | "flagged">,
  designId: string
): PrepareRegenerationResult {
  if (run.mode !== "manual") {
    return {
      ok: false,
      status: 400,
      error: 'Per-design regenerate is only available for a "manual" mode run — an "auto" run already auto-fixes eligible designs.',
    };
  }
  const flagged: FlaggedDesignEntry[] = JSON.parse(run.flagged);
  const entry = flagged.find((f) => f.designId === designId);
  if (!entry) {
    return { ok: false, status: 404, error: "This design was not flagged by this run." };
  }
  if (entry.siblingId) {
    return { ok: false, status: 409, error: `Already regenerated (sibling ${entry.siblingId}).` };
  }
  return { ok: true, entry };
}

export type { JudgeOneOutcome } from "./judge-designs-runner";
export { markDesignRegenerating };
