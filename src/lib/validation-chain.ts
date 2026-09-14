/**
 * The judge -> fix/regenerate -> judge state machine (issue #13). Wires
 * together design-judge.ts's judgeDesign() (issue #12), design-fix.ts's
 * applyProgrammaticFix() stub (issue #14), and design-regenerate.ts's
 * buildRegenerationConcept() stub (issue #15) into the actual transitions
 * described by Design.validationStatus's state machine (see
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
import { buildRegenerationConcept, type RegenerationSourceDesign } from "./design-regenerate";
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
 * mid-judge — see this module's top doc comment) and "regenerating" (the
 * state fix-design/regenerate-design leave the row/sibling in right before
 * re-enqueuing judge). */
const JUDGE_CLAIMABLE_STATUSES = ["pending", "unjudged", "regenerating", "validating"] as const;

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
  let route: "fix" | "regenerate" | "rejected";
  if (wantsFix && canFix) route = "fix";
  else if (!wantsFix && canRegen) route = "regenerate";
  else if (canFix) route = "fix";
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

  try {
    await applyFix(design, verdict);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Deliberately left at "regenerating" — that's judge-design's own
  // claimable entry state, and the caller (fix-design/route.ts)
  // re-enqueues judge right after this returns ok.
  return { ok: true };
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
   * inject a fake instead of spending a real Gemini call. */
  renderFn?: (sibling: Design) => Promise<Design>;
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

async function defaultRegenerateRenderFn(sibling: Design): Promise<Design> {
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
  return renderDesignArtwork(sibling, trace, rateLimit);
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
    sibling = await store.create({
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
    });
  }

  // Mark the source superseded regardless of whether the sibling is new or
  // was recovered from a retry — idempotent (a no-op UPDATE if it's already
  // "superseded"). See this module's top doc comment for why this has to
  // happen here, not left at "regenerating".
  await store.update(design.id, { validationStatus: "superseded" });

  if (sibling.status === "generating") {
    try {
      sibling = await renderFn(sibling);
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
