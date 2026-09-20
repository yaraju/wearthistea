/**
 * The judge -> fix/regenerate -> judge state machine (issue #13). Wires
 * together design-judge.ts's judgeDesign() (issue #12), design-fix.ts's
 * applyProgrammaticFix() (issue #14's programmatic fixes), and
 * design-regenerate.ts's buildRegenerationConcept()/buildRegenerationEdit()
 * (issue #15's targeted image-to-image regeneration) into the actual
 * transitions described by Design.validationStatus's state machine (see
 * prisma/schema.prisma's comment on that column, issue #11, and
 * src/lib/validation-status.ts's VALIDATION_STATUSES).
 *
 * Kept as a plain, side-effect-injectable module — no direct `prisma`
 * import at the top level (see DesignStore below) — so scripts/
 * test-validation-chain.ts can exercise the FULL state machine (one-fix-
 * cycle -> validated, fails-every-attempt -> rejected after exactly 2 fix +
 * 1 regen cycles, replay-doesn't-double-count) against an in-memory fake
 * store with a scripted fake judge, at zero cost and zero risk to the real
 * (shared prod) Design table — see AGENTS.md's DB-safety note and the
 * GCS_BUCKET gotcha in project memory. Production callers (the three
 * /api/tasks/*-design routes) use prismaDesignStore, the real judgeDesign,
 * and the real loadDesignImageBase64 below — all the exported defaults.
 *
 * ── #16-flagged design decision: source-row validationStatus during
 * sibling regeneration ──────────────────────────────────────────────────
 * runJudgeStep() sets the ORIGINAL design's validationStatus to
 * "regenerating" the moment it routes to EITHER fix-design or
 * regenerate-design — this is what makes KeywordStudio.tsx's
 * "Polishing a couple of details…" badge (issue #16) fire on the original
 * card at all, since that badge polls exactly this field.
 *   - Fix path: the row being fixed IS the original row, so it simply stays
 *     "regenerating" until the next judge pass moves it again. The badge
 *     keeps doing real, accurate work the whole time.
 *   - Regenerate path: a NEW sibling row is created instead (never mutating
 *     the original in place — see regeneratedFromDesignId's doc comment).
 *     runRegenerateStep() marks the ORIGINAL "superseded" (a terminal
 *     status, per validation-status.ts's own doc comment: "set on a design
 *     once #13's regeneration flow supersedes it with a new row") the
 *     moment the sibling exists, so the original's badge/polling correctly
 *     stops treating IT as in-flight. The sibling — created with the SAME
 *     batchId, so it rides along in the same /api/generate/status poll —
 *     is what carries the in-flight badge/polling forward from here via
 *     its OWN validationStatus lifecycle (freshly "pending", then through
 *     this same state machine again). This was the only sound choice:
 *     leaving the original at "regenerating" indefinitely (until the
 *     sibling's own eventual outcome) would be an unbounded in-flight state
 *     with no owner ever revisiting it — exactly the "stuck forever" shape
 *     STUCK_GENERATION_THRESHOLD_MINUTES (design-judge-bulk.ts) exists to
 *     catch for `status`, just for `validationStatus` instead.
 *
 * ── Attempt-cap routing policy ───────────────────────────────────────────
 * On a judge FAIL, judgeDesign()'s own `fix` field names its preferred
 * remedy: "relabel"/"invert-ink"/"rerun-bg-removal" (cheap, same-row) or
 * "regenerate" (full sibling). runJudgeStep() follows that preference as
 * long as its budget allows (validationFixAttempts < 2, or
 * validationRegenAttempts < 1 respectively); once the PREFERRED route's
 * budget is exhausted, it falls back to whichever OTHER budget still has
 * room, rather than rejecting immediately — matching the issue's literal
 * "once BOTH budgets are exhausted ... -> rejected" wording. Only once
 * neither budget has room does the design land at "rejected".
 *
 * A regeneration's sibling row carries the SOURCE's cumulative
 * validationFixAttempts/validationRegenAttempts forward (not reset to 0) —
 * without this, each new sibling would get its own fresh 2+1 budget and the
 * chain could regenerate indefinitely, one sibling at a time, which is
 * exactly what "never loop further" (this issue's validation criterion)
 * forbids. The cap is lineage-wide, not per-row.
 *
 * ── Issue #33 amendments (stranded "regenerating" rows) ──────────────────
 * "regenerating" now means "a fix/regenerate task owns this row" and is NOT
 * judge-claimable: runFixStep() CASes it to "pending" before judge is
 * re-enqueued, and runRegenerateStep() creates the sibling + supersedes the
 * source in ONE transaction (DesignStore.createSiblingAndSupersede). The
 * routing never sends a non-programmatic verdict to the fix queue. Every
 * step has an abandon* helper the route calls on the queue's final delivery
 * (src/lib/task-retry.ts), and src/lib/validation-sweeper.ts is the
 * backstop for anything still stuck in pending|validating|regenerating.
 *
 * ── Idempotency / retry tradeoff (documented, not fixed here) ────────────
 * Each step uses DesignStore.claim() — a compare-and-swap
 * (`UPDATE ... WHERE id = ? AND validationStatus IN (...)`) — so a Cloud
 * Tasks retry of a dispatch that already completed (validationStatus moved
 * to a terminal status: validated/rejected/superseded, none of which are
 * ever in a claim's expected-status set) safely no-ops instead of
 * re-judging or double-incrementing a counter. A retry of a dispatch that
 * crashed mid-flight (left at "validating") IS allowed to re-claim and
 * re-run — "validating" hasn't moved PAST the judge step, it's still
 * within it — which is what makes a genuinely-failed judge call
 * redrivable at all. The accepted residual risk (out of scope for #13):
 * two truly concurrent deliveries of the same task racing on "validating"/
 * "regenerating" aren't distinguished from each other by this compare-and-
 * swap (both match the same WHERE clause), so a rare concurrent double-
 * dispatch could still double-process. Cloud Tasks' delivery model makes
 * this rare (retries follow a failed response, not true concurrency); a
 * stronger guard (e.g. an optimistic-lock version column) is left for a
 * future issue if it's ever observed in practice.
 */
import type { Design, Prisma } from "@prisma/client";
import { z } from "zod";
import { judgeDesign, type JudgeVerdict } from "./design-judge";
import { applyProgrammaticFix } from "./design-fix";
import { buildRegenerationConcept, buildRegenerationEdit, type RegenerationSourceDesign } from "./design-regenerate";
import { assertDesignPathFieldsShape } from "./storage";
import { logger } from "./logger";

export const FIX_ATTEMPT_CAP = 2;
export const REGEN_ATTEMPT_CAP = 1;

/** Zod schema for JudgeVerdict — used to validate the fix-design/
 * regenerate-design Cloud Tasks payload (it's carried through the task body
 * rather than re-fetched/recomputed, since judge-design already computed it
 * once and re-judging to get it again would be a wasted Gemini call). Kept
 * here (not design-judge.ts) since it's specifically a wire-format concern
 * for this chain, not part of judgeDesign()'s own contract. */
export const judgeVerdictSchema = z.object({
  usable: z.boolean(),
  issues: z.array(z.string()),
  needsRegeneration: z.boolean(),
  regenerationPrompt: z.string(),
  colorMatchesArt: z.boolean(),
  fix: z.enum(["none", "relabel", "invert-ink", "rerun-bg-removal", "regenerate"]),
  measuredInkLuminance: z.number().nullable(),
}) satisfies z.ZodType<JudgeVerdict>;

// ─────────────────────────────────────────────────────────────────────────
// DesignStore — the one seam every step function goes through instead of
// importing `prisma` directly, so scripts/test-validation-chain.ts can
// substitute an in-memory fake. prismaDesignStore (below) is the real
// implementation every route handler uses by default.
// ─────────────────────────────────────────────────────────────────────────

export interface DesignStore {
  findById(id: string): Promise<Design | null>;
  findByRegeneratedFrom(sourceId: string): Promise<Design | null>;
  /** Compare-and-swap: writes `data` only if the row's CURRENT
   * validationStatus is one of `expectedStatuses`. Returns the updated row,
   * or null if the row doesn't exist or its status didn't match (already
   * handled by a prior/concurrent call — the caller should no-op). */
  claim(id: string, expectedStatuses: readonly string[], data: Prisma.DesignUncheckedUpdateInput): Promise<Design | null>;
  update(id: string, data: Prisma.DesignUncheckedUpdateInput): Promise<Design>;
  /** Plain-scalar create (batchId/regeneratedFromDesignId as bare fields,
   * not relation `connect` syntax) — matches the existing precedent in
   * /api/admin/designs/[id]/regenerate/route.ts and
   * design-judge-bulk.ts's flagAndTriggerStuckDesign(). */
  create(data: Prisma.DesignUncheckedCreateInput): Promise<Design>;
  /** Atomically (issue #33): flips `sourceId` from "regenerating" to
   * "superseded" AND creates the sibling, in one transaction. Returns null
   * (creating nothing) when the source isn't "regenerating" any more — a
   * late/duplicate regenerate task, so exactly one live chain exists per
   * lineage. Optional so pre-existing fakes (judge-run/judge-designs
   * tests) that only implement create() keep working; runRegenerateStep
   * falls back to a claim()-then-create() ordering when absent. */
  createSiblingAndSupersede?(sourceId: string, data: Prisma.DesignUncheckedCreateInput): Promise<Design | null>;
}

export const prismaDesignStore: DesignStore = {
  async findById(id) {
    const { prisma } = await import("./prisma");
    return prisma.design.findUnique({ where: { id } });
  },
  async findByRegeneratedFrom(sourceId) {
    const { prisma } = await import("./prisma");
    return prisma.design.findUnique({ where: { regeneratedFromDesignId: sourceId } });
  },
  async claim(id, expectedStatuses, data) {
    const { prisma } = await import("./prisma");
    const result = await prisma.design.updateMany({
      where: { id, validationStatus: { in: [...expectedStatuses] } },
      data,
    });
    if (result.count === 0) return null;
    return prisma.design.findUnique({ where: { id } });
  },
  async update(id, data) {
    const { prisma } = await import("./prisma");
    return prisma.design.update({ where: { id }, data });
  },
  async create(data) {
    const { prisma } = await import("./prisma");
    return prisma.design.create({ data });
  },
  async createSiblingAndSupersede(sourceId, data) {
    const { prisma } = await import("./prisma");
    return prisma.$transaction(async (tx) => {
      const flipped = await tx.design.updateMany({
        where: { id: sourceId, validationStatus: "regenerating" },
        data: { validationStatus: "superseded" },
      });
      if (flipped.count === 0) return null;
      return tx.design.create({ data });
    });
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────

/** Loads a design's front print art as base64 for judgeDesign() — same
 * GCS-then-designImageData-fallback pattern as fulfillment.ts's Printrove
 * upload (design-products.ts / fulfillment.ts both do this identically). */
export async function loadDesignImageBase64(
  design: Pick<Design, "designImagePath" | "designImageData">
): Promise<string> {
  const { readImageAsBase64 } = await import("./storage");
  try {
    return await readImageAsBase64(design.designImagePath);
  } catch {
    if (!design.designImageData) {
      throw new Error("Judge: artwork file is missing and no database copy exists.");
    }
    return design.designImageData;
  }
}

function summarizeVerdict(verdict: JudgeVerdict): string {
  const json = JSON.stringify({
    usable: verdict.usable,
    colorMatchesArt: verdict.colorMatchesArt,
    fix: verdict.fix,
    issues: verdict.issues,
    measuredInkLuminance: verdict.measuredInkLuminance,
  });
  // validationNotes is "for debugging and admin visibility only" (schema.prisma) —
  // truncate defensively rather than ever writing an unbounded blob.
  return json.length > 4000 ? `${json.slice(0, 4000)}…` : json;
}

// ─────────────────────────────────────────────────────────────────────────
// Step 1: judge
// ─────────────────────────────────────────────────────────────────────────

/** validationStatus values from which a judge pass may run. Includes
 * "validating" itself (a redrivable retry of a dispatch that crashed
 * mid-judge — see this module's top doc comment). Deliberately does NOT
 * include "regenerating" (issue #33): that status now means "a fix or
 * regenerate task owns this row", and fix-design moves the row to "pending"
 * before re-enqueuing judge, so a duplicate/late judge task can no longer
 * re-claim a row a fix/regenerate task is working and start a second chain. */
const JUDGE_CLAIMABLE_STATUSES = ["pending", "unjudged", "validating"] as const;

export type ChainAction =
  | { type: "validated" }
  | { type: "rejected" }
  | { type: "enqueue-fix"; verdict: JudgeVerdict }
  | { type: "enqueue-regenerate"; verdict: JudgeVerdict }
  | { type: "skipped"; reason: string };

export interface JudgeStepDeps {
  store?: DesignStore;
  judgeFn?: typeof judgeDesign;
  loadImage?: (design: Design) => Promise<string>;
}

export async function runJudgeStep(designId: string, deps: JudgeStepDeps = {}): Promise<ChainAction> {
  const store = deps.store ?? prismaDesignStore;
  const judgeFn = deps.judgeFn ?? judgeDesign;
  const loadImage = deps.loadImage ?? loadDesignImageBase64;

  const claimed = await store.claim(designId, JUDGE_CLAIMABLE_STATUSES, { validationStatus: "validating" });
  if (!claimed) {
    return {
      type: "skipped",
      reason: "design missing, or not in a judgeable validationStatus (already validated/rejected/superseded, or a duplicate dispatch)",
    };
  }

  const claimedColor =
    claimed.variantColor === "Black" || claimed.variantColor === "White" ? claimed.variantColor : null;
  if (!claimedColor) {
    // Shouldn't normally happen — render-design writes variantColor before
    // ever enqueuing judge — but a design judged out of band (or a stale
    // row from before variantColor existed) has nothing for judgeDesign()
    // to compare against. Leave it "unjudged" rather than guessing a color.
    await store.update(designId, {
      validationStatus: "unjudged",
      validationNotes: "Judge skipped: Design.variantColor is not resolved to Black/White.",
    });
    return { type: "skipped", reason: "variantColor not resolved to Black/White" };
  }

  const imageB64 = await loadImage(claimed);
  const verdict = await judgeFn(claimed, imageB64, claimedColor);

  if (verdict.usable && verdict.colorMatchesArt) {
    await store.update(designId, { validationStatus: "validated", validationNotes: summarizeVerdict(verdict) });
    return { type: "validated" };
  }

  const fixAttempts = claimed.validationFixAttempts;
  const regenAttempts = claimed.validationRegenAttempts;
  const wantsFix = verdict.fix === "relabel" || verdict.fix === "invert-ink" || verdict.fix === "rerun-bg-removal";
  const canFix = fixAttempts < FIX_ATTEMPT_CAP;
  const canRegen = regenAttempts < REGEN_ATTEMPT_CAP;

  // See this module's top doc comment ("Attempt-cap routing policy") for
  // the full rationale.
  //
  // Issue #33: falling back to the OTHER budget is only valid when it can
  // actually act on this verdict. A cheap fix only applies when verdict.fix
  // names a programmatic fix — the old "regen budget spent, canFix -> fix"
  // fallback enqueued fix-design for verdict.fix "regenerate"/"none", which
  // applyProgrammaticFix() can only throw on, permanently, until Cloud Tasks
  // gave up and the row sat at "regenerating" forever (the root cause of
  // prod batch cmu8ocut8...). Nothing cheap applies there: reject instead.
  let route: "fix" | "regenerate" | "rejected";
  if (wantsFix && canFix) route = "fix";
  else if (canRegen) route = "regenerate";
  else route = "rejected";

  if (route === "rejected") {
    await store.update(designId, { validationStatus: "rejected", validationNotes: summarizeVerdict(verdict) });
    return { type: "rejected" };
  }

  if (route === "fix") {
    await store.update(designId, {
      // See top doc comment's "#16-flagged design decision" section.
      validationStatus: "regenerating",
      validationFixAttempts: fixAttempts + 1,
      validationNotes: summarizeVerdict(verdict),
    });
    return { type: "enqueue-fix", verdict };
  }

  await store.update(designId, {
    validationStatus: "regenerating",
    validationRegenAttempts: regenAttempts + 1,
    validationNotes: summarizeVerdict(verdict),
  });
  return { type: "enqueue-regenerate", verdict };
}

// ─────────────────────────────────────────────────────────────────────────
// Step 2a: programmatic fix (same row)
// ─────────────────────────────────────────────────────────────────────────

export interface FixStepDeps {
  store?: DesignStore;
  applyFix?: (design: Design, verdict: JudgeVerdict) => Promise<unknown>;
}

export interface FixStepResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

export async function runFixStep(
  designId: string,
  verdict: JudgeVerdict,
  deps: FixStepDeps = {}
): Promise<FixStepResult> {
  const store = deps.store ?? prismaDesignStore;
  const applyFix = deps.applyFix ?? applyProgrammaticFix;

  const design = await store.findById(designId);
  if (!design || design.validationStatus !== "regenerating") {
    // Stale/retried dispatch — judge-design already moved this design past
    // the state fix-design expects (or it never reached "regenerating" at
    // all), so there's nothing for this call to do.
    return { ok: true, skipped: true };
  }

  if (verdict.fix !== "relabel" && verdict.fix !== "invert-ink" && verdict.fix !== "rerun-bg-removal") {
    // Permanent, not transient (issue #33): no retry can make a
    // non-programmatic verdict fixable, so don't burn the queue's retry
    // budget (and strand the row when it runs out) — end the row now.
    await abandonStep(store, designId, "regenerating", `Fix step given a non-programmatic verdict (fix="${verdict.fix}").`);
    return { ok: true, skipped: true };
  }

  try {
    await applyFix(design, verdict);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Hand the row back to the judge's claimable state BEFORE the caller
  // re-enqueues judge (issue #33): "regenerating" means "a fix/regenerate
  // task owns this row" and is no longer judge-claimable, so this CAS is
  // also what makes a duplicate/late fix task (or one whose row was
  // superseded/swept meanwhile) a no-op instead of a second judge enqueue.
  const handedBack = await store.claim(designId, ["regenerating"], { validationStatus: "pending" });
  if (!handedBack) return { ok: true, skipped: true };
  return { ok: true };
}

/**
 * Ends a row that a failed/exhausted task can no longer advance (issue #33)
 * so it is never stranded in an in-flight status. CAS on `fromStatus` so it
 * never clobbers a row another task already moved on. `to` defaults to
 * "rejected"; the judge step uses "unjudged" (art untouched, just never
 * judged — a valid settled state).
 */
export async function abandonStep(
  store: DesignStore,
  designId: string,
  fromStatus: string,
  reason: string,
  to: "rejected" | "unjudged" = "rejected"
): Promise<boolean> {
  const row = await store.claim(designId, [fromStatus], {
    validationStatus: to,
    validationNotes: `[chain] ${reason}`.slice(0, 4000),
  });
  if (row) logger.error(`[validation-chain] Row ${designId} ended as "${to}": ${reason}`, { designId });
  return Boolean(row);
}

/** Final-retry hook for fix-design (issue #33): the queue is about to stop
 * redelivering, so end the row rather than leave it at "regenerating". */
export async function abandonFixStep(designId: string, reason: string, store: DesignStore = prismaDesignStore) {
  return abandonStep(store, designId, "regenerating", `Fix failed after retries: ${reason}`);
}

/** Final-retry hook for judge-design (issue #33): leave the row "unjudged". */
export async function abandonJudgeStep(designId: string, reason: string, store: DesignStore = prismaDesignStore) {
  return abandonStep(store, designId, "validating", `Judge failed after retries: ${reason}`, "unjudged");
}

/** Final-retry hook for regenerate-design (issue #33): the sibling exists
 * (source already superseded) but could never be rendered — mark it failed
 * and rejected so the lineage ends terminal instead of "pending" forever. */
export async function abandonRegenerateStep(
  sourceId: string,
  reason: string,
  store: DesignStore = prismaDesignStore
): Promise<boolean> {
  const sibling = await store.findByRegeneratedFrom(sourceId);
  if (!sibling) {
    // Sibling never got created: the source is still "regenerating".
    return abandonStep(store, sourceId, "regenerating", `Regeneration failed after retries: ${reason}`);
  }
  const row = await store.claim(sibling.id, ["pending", "validating"], {
    status: sibling.status === "generated" ? sibling.status : "failed",
    errorMessage: sibling.status === "generated" ? sibling.errorMessage : reason.slice(0, 1000),
    validationStatus: "rejected",
    validationNotes: `[chain] Regeneration failed after retries: ${reason}`.slice(0, 4000),
  });
  return Boolean(row);
}

// ─────────────────────────────────────────────────────────────────────────
// Judge + route: judge, then enqueue the next queue, rolling the row back if
// the enqueue fails (issue #33) so a retry can resume instead of no-op'ing
// on a row already flipped to "regenerating".
// ─────────────────────────────────────────────────────────────────────────

export interface JudgeAndRouteDeps extends JudgeStepDeps {
  enqueueFix: (designId: string, verdict: JudgeVerdict) => Promise<boolean>;
  enqueueRegenerate: (designId: string, verdict: JudgeVerdict) => Promise<boolean>;
}

/**
 * runJudgeStep() + dispatching its enqueue-fix/enqueue-regenerate action.
 * If the enqueue throws, the row is rolled back to "validating" with the
 * attempt counter it just consumed given back, then the error is rethrown
 * (route -> 5xx -> the redelivered judge task re-claims "validating" and
 * re-routes cleanly, instead of finding the row already at "regenerating",
 * no-op'ing, and double-counting). If the queue simply isn't configured
 * (returns false), nothing will ever pick the row up, so it ends "unjudged".
 */
export async function runJudgeAndRoute(designId: string, deps: JudgeAndRouteDeps): Promise<ChainAction> {
  const store = deps.store ?? prismaDesignStore;
  const action = await runJudgeStep(designId, deps);
  if (action.type !== "enqueue-fix" && action.type !== "enqueue-regenerate") return action;

  const isFix = action.type === "enqueue-fix";
  let queued = false;
  let enqueueError: unknown;
  try {
    queued = await (isFix ? deps.enqueueFix : deps.enqueueRegenerate)(designId, action.verdict);
  } catch (err) {
    enqueueError = err;
  }
  if (queued) return action;

  const row = await store.findById(designId);
  if (row && row.validationStatus === "regenerating") {
    if (enqueueError) {
      await store.claim(designId, ["regenerating"], {
        validationStatus: "validating",
        ...(isFix
          ? { validationFixAttempts: Math.max(0, row.validationFixAttempts - 1) }
          : { validationRegenAttempts: Math.max(0, row.validationRegenAttempts - 1) }),
      });
    } else {
      await abandonStep(
        store,
        designId,
        "regenerating",
        `${isFix ? "Fix" : "Regenerate"} queue not configured — nothing to redrive this design.`,
        "unjudged"
      );
    }
  }
  if (enqueueError) throw enqueueError;
  return { type: "skipped", reason: `${isFix ? "fix" : "regenerate"} queue not configured` };
}

// ─────────────────────────────────────────────────────────────────────────
// Step 2b: full regeneration (new sibling row)
// ─────────────────────────────────────────────────────────────────────────

export interface RegenerateStepDeps {
  store?: DesignStore;
  buildConcept?: (source: RegenerationSourceDesign, verdict: JudgeVerdict) => ReturnType<typeof buildRegenerationConcept>;
  /** Renders the freshly-created sibling's artwork and returns the updated
   * row. Defaults to a real call into design-render.ts's
   * renderDesignArtwork() with a synthetic unlimited-budget rate limit —
   * same pattern as design-judge-bulk.ts's flagAndTriggerStuckDesign(),
   * since this is a system-triggered render, not a customer action. Tests
   * inject a fake instead of spending a real Gemini call.
   *
   * Receives `source` and `verdict` alongside `sibling` (issue #15) so the
   * default implementation can load the SOURCE's current image and pair it
   * with verdict.regenerationPrompt for a targeted image-to-image edit
   * (design-regenerate.ts's buildRegenerationEdit() ->
   * gemini.ts's renderConceptArtFix()) instead of a from-scratch re-roll. A
   * fake that only accepts one argument (e.g. scripts/test-validation-
   * chain.ts's fakeRenderFn) remains a valid implementation of this type —
   * TS allows a function with fewer parameters to satisfy a type expecting
   * more — so existing tests need no changes for this widening. */
  renderFn?: (sibling: Design, source: Design, verdict: JudgeVerdict) => Promise<Design>;
}

export interface RegenerateStepResult {
  ok: boolean;
  skipped?: boolean;
  siblingId?: string;
  /** The design id the caller should re-enqueue judge for. Only set when
   * a sibling was successfully created — undefined on skip or render
   * failure (retrying the same task will pick the existing sibling back
   * up via findByRegeneratedFrom). */
  judgeTargetId?: string;
  error?: string;
}

/**
 * Default renderFn (issue #15): a TARGETED image-to-image edit of the
 * source design's current art, not a from-scratch re-roll — loads the
 * source's current image (loadDesignImageBase64(), same helper judge-design
 * uses) and pairs it with buildRegenerationEdit(verdict)'s instruction via
 * renderDesignArtwork()'s `edit` parameter (design-render.ts ->
 * gemini.ts's renderConceptArtFix()).
 *
 * If loading the source's image fails (missing GCS object, no DB fallback
 * copy, etc.), this falls back to a from-scratch re-roll (renderFn's `edit`
 * left undefined) rather than throwing — by the time renderFn runs, the
 * source has already been marked "superseded" and the sibling row already
 * exists with no other owner watching it, so a hard failure here would
 * leave the sibling stuck at "generating" forever with nothing left to
 * redrive it. A same-quality-bar re-roll is a better outcome than that.
 */
async function defaultRegenerateRenderFn(sibling: Design, source: Design, verdict: JudgeVerdict): Promise<Design> {
  const { renderDesignArtwork } = await import("./design-render");
  const { langfuse } = await import("./langfuse");
  const trace = langfuse.trace({ name: "regenerate-design-task", input: { designId: sibling.id } });
  // Mirrors design-judge-bulk.ts's flagAndTriggerStuckDesign(): a
  // system-triggered render, not a customer's free-generation budget spend.
  const rateLimit = {
    ok: true as const,
    tier: "admin" as const,
    bucketKey: "ratelimit:generate:task:regenerate-design",
    windowMs: 60 * 60 * 1000,
    limit: Number.MAX_SAFE_INTEGER,
  };

  let edit: { sourceImageB64: string; instruction: string } | undefined;
  try {
    const sourceImageB64 = await loadDesignImageBase64(source);
    edit = { sourceImageB64, instruction: buildRegenerationEdit(verdict).instruction };
  } catch (err) {
    logger.error(
      `[defaultRegenerateRenderFn] Failed to load source design's image for a targeted edit — falling back to a from-scratch re-roll for design ${source.id} -> sibling ${sibling.id}: ${err instanceof Error ? err.message : String(err)}`,
      { designId: source.id, siblingId: sibling.id, error: err }
    );
  }

  return renderDesignArtwork(sibling, trace, rateLimit, edit);
}

/** Fallback for stores without createSiblingAndSupersede(): CAS the source
 * "regenerating" -> "superseded" first (only one caller wins), then create,
 * un-flipping the source if the create fails so it isn't orphaned. */
async function createSiblingFallback(
  store: DesignStore,
  sourceId: string,
  data: Prisma.DesignUncheckedCreateInput
): Promise<Design | null> {
  const flipped = await store.claim(sourceId, ["regenerating"], { validationStatus: "superseded" });
  if (!flipped) return null;
  try {
    return await store.create(data);
  } catch (err) {
    await store.update(sourceId, { validationStatus: "regenerating" });
    throw err;
  }
}

export async function runRegenerateStep(
  designId: string,
  verdict: JudgeVerdict,
  deps: RegenerateStepDeps = {}
): Promise<RegenerateStepResult> {
  const store = deps.store ?? prismaDesignStore;
  const buildConcept = deps.buildConcept ?? buildRegenerationConcept;
  const renderFn = deps.renderFn ?? defaultRegenerateRenderFn;

  const design = await store.findById(designId);
  if (!design) {
    return { ok: true, skipped: true };
  }

  // Idempotent retry: a prior attempt may have already created the sibling
  // (regeneratedFromDesignId is @unique — a second `create` would P2002)
  // but crashed before rendering it, before marking the source
  // "superseded", or before the route handler got as far as re-enqueuing
  // judge for it. Check for an existing sibling FIRST, before even looking
  // at the source's current validationStatus — a retry must keep ensuring
  // the sibling gets judged even if the source already moved past
  // "regenerating" (e.g. to "superseded") on a prior, only-partially-acked
  // attempt, or the sibling would be silently orphaned at "pending"
  // forever with nothing left to redrive it.
  let sibling = await store.findByRegeneratedFrom(design.id);

  if (!sibling) {
    if (design.validationStatus !== "regenerating") {
      // No sibling exists yet, and this design isn't currently routed for
      // regeneration — a genuinely stale/duplicate dispatch, nothing to do.
      return { ok: true, skipped: true };
    }
    const concept = buildConcept(design, verdict);
    const pathFields = {
      designImagePath: "",
      productImagePath: "",
      designPreviewImagePath: "",
      productPreviewImagePath: "",
    };
    assertDesignPathFieldsShape(pathFields);
    const siblingData: Prisma.DesignUncheckedCreateInput = {
      batchId: design.batchId,
      title: concept.title,
      phrase: concept.phrase,
      visualConcept: concept.visualConcept,
      vibe: design.vibe,
      blurb: design.blurb,
      backPhrase: design.backPhrase,
      backLayout: design.backLayout,
      style: design.style,
      designPrompt: concept.designPrompt,
      productPrompt: concept.productPrompt,
      category: design.category,
      variantColor: design.variantColor,
      ...pathFields,
      status: "generating",
      validationStatus: "pending",
      // Carry the cumulative attempt budget forward — see this module's
      // top doc comment ("Attempt-cap routing policy") for why this must
      // NOT reset to 0.
      validationFixAttempts: design.validationFixAttempts,
      validationRegenAttempts: design.validationRegenAttempts,
      regeneratedFromDesignId: design.id,
    };
    // Issue #33: supersede the source and create the sibling ATOMICALLY,
    // conditional on the source still being "regenerating" — a late or
    // concurrent duplicate dispatch gets null here and no-ops instead of
    // starting a second chain for the same lineage.
    const created = store.createSiblingAndSupersede
      ? await store.createSiblingAndSupersede(design.id, siblingData)
      : await createSiblingFallback(store, design.id, siblingData);
    if (!created) return { ok: true, skipped: true };
    sibling = created;
  } else if (design.validationStatus === "regenerating") {
    // Retry after a partial prior attempt (sibling exists, source not yet
    // flipped) — idempotent conditional flip, see above.
    await store.claim(design.id, ["regenerating"], { validationStatus: "superseded" });
  }

  if (sibling.status === "generating") {
    try {
      sibling = await renderFn(sibling, design, verdict);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[runRegenerateStep] Sibling render failed for design ${design.id} -> ${sibling.id}: ${message}`, {
        designId: design.id,
        siblingId: sibling.id,
        error: err,
      });
      return { ok: false, siblingId: sibling.id, error: message };
    }
  }

  return { ok: true, siblingId: sibling.id, judgeTargetId: sibling.id };
}
