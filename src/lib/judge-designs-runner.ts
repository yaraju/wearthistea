/**
 * Core per-design decision logic for scripts/judge-designs.ts (issue #18) —
 * the bulk judge runner over the existing Design backlog. Split out from the
 * CLI script itself (mirrors design-judge-bulk.ts / validation-chain.ts's
 * own split between reusable src/lib logic and thin scripts/ CLI wrappers)
 * so the exact judge -> action decision for one design is unit-testable
 * against a fixture DesignStore and stubbed judge/audit/style functions —
 * no real DB, no real Gemini call — see scripts/test-judge-designs.ts.
 *
 * Deliberately does NOT reuse validation-chain.ts's runJudgeStep() for the
 * fail-routing decision. runJudgeStep() picks between an in-place
 * programmatic fix (runFixStep -> applyProgrammaticFix: relabel/invert-ink/
 * rerun-bg-removal, which mutates the SAME row) and a full sibling
 * regeneration, based on the judge's preferred fix + remaining attempt
 * budget — that's the live per-design chain's policy (issue #13). Issue #18
 * explicitly overrides that policy for a bulk sweep over EXISTING, possibly
 * browsable/purchased rows: "for anything that needs a fix, creates a
 * sibling rather than mutating the original in place." So this module never
 * calls runFixStep/applyProgrammaticFix at all — every judge failure that
 * isn't excluded (see computeExclusion below) goes through the sibling
 * path, reusing validation-chain.ts's runRegenerateStep() directly for the
 * actual sibling-creation / lineage-link / supersede / render mechanics
 * (the same code already proven by scripts/test-validation-chain.ts, and
 * itself documented as mirroring /api/admin/designs/[id]/regenerate/
 * route.ts's create shape: copy concept/prompt text + variantColor, reset
 * image paths, status "generating", no Printrove/DesignProduct carryover).
 * The only difference from the live path here is *what drives the state
 * transition into "regenerating"* (this module, not runJudgeStep) and *which
 * rate-limit bucket a triggered render spends from* (the CLI script's own
 * isolated bucket, injected via `renderFn` — see scripts/judge-designs.ts).
 */
import type { Design } from "@prisma/client";
import { judgeDesign, type JudgeVerdict } from "./design-judge";
import {
  auditDesignIntegrity,
  checkStyleAlignment,
  isStuckGenerating,
  type IntegrityVerdict,
  type StyleVerdict,
  type BulkDesignVerdict,
} from "./design-judge-bulk";
import { hasDurableStorage } from "./storage";
import {
  prismaDesignStore,
  loadDesignImageBase64,
  runRegenerateStep,
  type DesignStore,
  type RegenerateStepDeps,
} from "./validation-chain";

// ─────────────────────────────────────────────────────────────────────────
// Exclusion: designs already attached to a placed Order or a live/fulfilled
// DesignProduct never get auto-fixed — flagged for admin review instead.
// ─────────────────────────────────────────────────────────────────────────

export interface ExclusionResult {
  excluded: boolean;
  reasons: string[];
}

/**
 * Pure — takes plain arrays (the shape a `prisma.design.findMany({include:
 * {orders:{select:{status:true}}, designProducts:{select:{status:true,
 * approvalStatus:true}}}})` row already carries), so it's directly
 * unit-testable without a fixture DB.
 *
 * "Placed Order": any Order whose status isn't "pending_payment". Order-
 * status.ts's own doc comment is explicit about that carve-out: a
 * "pending_payment" row is an "Abandoned Razorpay checkout, never actually
 * placed" — every other status (pending, published, rejected, failed,
 * cancelled) represents an order a customer or the COD flow actually
 * submitted.
 *
 * "Live/fulfilled DesignProduct": approvalStatus === "approved" (per the
 * DesignProduct model's own comment, approving this row makes every
 * CURRENT AND FUTURE Order for the combo auto-fulfill — a real live-content
 * commitment) OR status === "ready" (a built Printrove product/mockup —
 * design-products.ts's ensureDesignProduct sets this once the mockup
 * exists). Either makes silently regenerating the underlying art a
 * different, riskier class of change than fixing a browsable-but-unpurchased
 * design — see issue #18's scope.
 */
export function computeExclusion(
  orders: { status: string }[],
  designProducts: { status: string; approvalStatus: string }[]
): ExclusionResult {
  const reasons: string[] = [];
  const placedOrders = orders.filter((o) => o.status !== "pending_payment");
  const liveDesignProducts = designProducts.filter((dp) => dp.status === "ready" || dp.approvalStatus === "approved");
  if (placedOrders.length > 0) reasons.push(`attached to ${placedOrders.length} placed Order(s)`);
  if (liveDesignProducts.length > 0) {
    reasons.push(`attached to ${liveDesignProducts.length} live/fulfilled DesignProduct(s)`);
  }
  return { excluded: reasons.length > 0, reasons };
}

// ─────────────────────────────────────────────────────────────────────────
// Per-design judge + act
// ─────────────────────────────────────────────────────────────────────────

export type JudgeOneOutcome =
  | "validated"
  | "would-validate"
  | "sibling-created"
  | "sibling-created-render-failed"
  | "would-create-sibling"
  | "flagged-for-review"
  | "skipped";

export interface JudgeOneResult {
  designId: string;
  outcome: JudgeOneOutcome;
  detail: string;
  verdict: BulkDesignVerdict;
  siblingId?: string;
  /** Full integrity breakdown (not just the pass/fail BulkDesignVerdict
   * carries) — lets a caller distinguish a genuine loss (hasLostObjects,
   * the actual incident auditDesignIntegrity() exists to catch) from a
   * legacy pre-feature row (hasMissingFields, e.g. no back print yet) when
   * summarizing a run — see auditDesignIntegrity()'s own doc comment on
   * why `passed` alone reads as "half the catalog is broken" for rows that
   * simply predate a feature. */
  integrityDetail?: { hasLostObjects: boolean; hasMissingFields: boolean };
  /** The full color-fitness/garment-in-graphic verdict from judgeFn — set
   * whenever the judge call actually ran (every outcome except an early
   * "skipped" return before judgeFn was ever called). Exposed so a caller
   * with its own out-of-band action to trigger LATER (issue #19's admin UI:
   * a manual-mode "regenerate this flagged design" button, clicked well
   * after this judgeOneDesign() call returned) can build the exact same
   * regeneration edit regenerateDesignSibling()/runRegenerateStep() would
   * have used automatically — without spending a second judge call (a
   * second Gemini round-trip that could even come back with a different
   * verdict) just to reconstruct it. */
  judgeVerdict?: JudgeVerdict;
}

export interface JudgeOneDeps {
  store?: DesignStore;
  judgeFn?: typeof judgeDesign;
  loadImage?: (design: Design) => Promise<string>;
  auditFn?: (design: Design) => Promise<IntegrityVerdict>;
  styleFn?: (design: Design) => Promise<StyleVerdict>;
  renderFn?: RegenerateStepDeps["renderFn"];
  now?: Date;
  /** Whether integrity checks may run at all — mirrors auditDesignIntegrity()'s
   * own refusal to run against the real existsInGcs() when GCS_BUCKET is
   * unset (storage.ts's hasDurableStorage / AGENTS.md's GCS_BUCKET gotcha).
   * Defaults to the real hasDurableStorage; tests set this to false to skip
   * integrity entirely without needing a GCS stub. */
  canAudit?: boolean;
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

/**
 * Judges (and, when `apply` is true, acts on) exactly one design.
 *
 * Every write this function can reach — store.update() and
 * runRegenerateStep()'s create/update/render — is inside an `if (apply)`
 * branch. With apply=false, this function only ever calls judgeFn/auditFn/
 * styleFn (pure computations / read-only external calls) and loadImage
 * (a GCS/DB read) — genuinely no database mutation is reachable, which is
 * what makes dry-run mode safe to run against the real production DB.
 */
export async function judgeOneDesign(
  design: Design,
  exclusion: ExclusionResult,
  apply: boolean,
  deps: JudgeOneDeps = {}
): Promise<JudgeOneResult> {
  const store = deps.store ?? prismaDesignStore;
  const judgeFn = deps.judgeFn ?? judgeDesign;
  const loadImage = deps.loadImage ?? loadDesignImageBase64;
  const auditFn = deps.auditFn ?? auditDesignIntegrity;
  const styleFn = deps.styleFn ?? checkStyleAlignment;
  const now = deps.now ?? new Date();
  const canAudit = deps.canAudit ?? hasDurableStorage;

  const stuck = isStuckGenerating(design, now);

  if (design.status === "generating") {
    // No artwork to judge yet. Reported via the stuck-generation rubric
    // only (isStuckGenerating is a pure predicate, no I/O) — this script
    // deliberately does NOT trigger design-judge-bulk.ts's
    // flagAndTriggerStuckDesign() action here (marking "failed" + spawning
    // + rendering a sibling): that's a side effect issue #18's scope never
    // asked for ("Reports the five named rubrics..."), and stays owned by
    // whatever separately runs the #17 stuck sweep.
    return {
      designId: design.id,
      outcome: "skipped",
      detail: stuck
        ? `stuck at status "generating" for ~${Math.round((now.getTime() - design.updatedAt.getTime()) / 60000)}m — reported in the stuck-generation rubric only, no action taken here`
        : `status is "generating" (still in flight) — no artwork to judge yet`,
      verdict: { designId: design.id, stuck },
    };
  }

  if (design.status !== "generated") {
    return {
      designId: design.id,
      outcome: "skipped",
      detail: `status is "${design.status}", not "generated" — nothing to judge`,
      verdict: { designId: design.id, stuck },
    };
  }

  const claimedColor =
    design.variantColor === "Black" || design.variantColor === "White" ? design.variantColor : null;
  if (!claimedColor) {
    return {
      designId: design.id,
      outcome: "skipped",
      detail: "variantColor is not resolved to Black/White",
      verdict: { designId: design.id, stuck },
    };
  }

  let imageB64: string;
  try {
    imageB64 = await loadImage(design);
  } catch (err) {
    return {
      designId: design.id,
      outcome: "skipped",
      detail: `couldn't load artwork: ${err instanceof Error ? err.message : String(err)}`,
      verdict: { designId: design.id, stuck },
    };
  }

  let judgeVerdict: JudgeVerdict;
  try {
    judgeVerdict = await judgeFn(design, imageB64, claimedColor);
  } catch (err) {
    return {
      designId: design.id,
      outcome: "skipped",
      detail: `judge call failed: ${err instanceof Error ? err.message : String(err)}`,
      verdict: { designId: design.id, stuck },
    };
  }

  // Bulk-only rubrics (#17) — report-only in this script, never drive the
  // fix/validate decision below (that's judgeVerdict alone, matching the
  // live path's own pass condition in validation-chain.ts's runJudgeStep).
  // Each is independently best-effort: a failure/exception here just omits
  // that design from the rubric's denominator (buildRubricReport filters on
  // the field being present), never crashes the whole design's judge pass.
  let integrity: IntegrityVerdict | undefined;
  if (canAudit) {
    try {
      integrity = await auditFn(design);
    } catch {
      integrity = undefined;
    }
  }
  let style: StyleVerdict | undefined;
  try {
    style = await styleFn(design);
  } catch {
    style = undefined;
  }

  const verdict: BulkDesignVerdict = {
    designId: design.id,
    judge: { colorMatchesArt: judgeVerdict.colorMatchesArt, usable: judgeVerdict.usable },
    integrity: integrity ? { passed: integrity.passed } : undefined,
    style: style ? { aligned: style.aligned } : undefined,
    stuck,
  };
  const integrityDetail = integrity
    ? { hasLostObjects: integrity.hasLostObjects, hasMissingFields: integrity.hasMissingFields }
    : undefined;

  const passed = judgeVerdict.usable && judgeVerdict.colorMatchesArt;

  if (passed) {
    if (apply) {
      await store.update(design.id, {
        validationStatus: "validated",
        validationNotes: summarizeVerdict(judgeVerdict),
      });
    }
    return {
      designId: design.id,
      outcome: apply ? "validated" : "would-validate",
      detail: "passes color-fitness and garment-in-graphic as-is",
      verdict,
      integrityDetail,
      judgeVerdict,
    };
  }

  const issueSummary = judgeVerdict.issues.join("; ") || "see validationNotes";

  if (exclusion.excluded) {
    return {
      designId: design.id,
      outcome: "flagged-for-review",
      detail: `judge failed (${issueSummary}) but excluded from auto-fix: ${exclusion.reasons.join("; ")}`,
      verdict,
      integrityDetail,
      judgeVerdict,
    };
  }

  if (!apply) {
    return {
      designId: design.id,
      outcome: "would-create-sibling",
      detail: `judge failed (${issueSummary}) — would create a regenerated sibling and mark this row "superseded"`,
      verdict,
      integrityDetail,
      judgeVerdict,
    };
  }

  const regenResult = await regenerateDesignSibling(design, judgeVerdict, { store, renderFn: deps.renderFn });

  // Distinct outcome for a render failure (rather than folding it into
  // "sibling-created") — the sibling row DOES exist and the original IS
  // superseded either way, but a render failure leaves the sibling stuck at
  // status "generating" with no art yet, which a human scanning the
  // "=== Outcome counts ===" block needs to see broken out from a clean
  // success, not silently bucketed together with it.
  return {
    designId: design.id,
    outcome: regenResult.ok ? "sibling-created" : "sibling-created-render-failed",
    detail: regenResult.ok
      ? `created sibling ${regenResult.siblingId}, linked via regeneratedFromDesignId, original marked "superseded"`
      : `sibling ${regenResult.siblingId ?? "(none)"} created (original marked "superseded") but render failed: ${regenResult.error}`,
    verdict,
    siblingId: regenResult.siblingId,
    integrityDetail,
    judgeVerdict,
  };
}

/**
 * Moves a design into "regenerating" and creates+renders its sibling — the
 * exact action judgeOneDesign() takes on an --apply judge failure (extracted
 * here, issue #19, so the admin UI's manual-mode "regenerate this flagged
 * design" button can trigger THE SAME action, admin-triggered per item
 * instead of automatically, reusing this instead of forking a second copy of
 * it). `judgeVerdict` is normally the one judgeOneDesign()'s own call to
 * judgeFn just produced (see JudgeOneResult.judgeVerdict) — for a manual
 * trigger, called well after that judge pass returned, the caller passes the
 * SAME stored verdict back in rather than spending a second Gemini call to
 * reconstruct it.
 *
 * Precondition (mirrors judgeOneDesign()'s own inline comment this replaces):
 * runRegenerateStep()'s precondition is that the source is already
 * "regenerating" (unless a sibling already exists from a prior partial run)
 * — this function satisfies that itself before calling it.
 */
export async function regenerateDesignSibling(
  design: Design,
  judgeVerdict: JudgeVerdict,
  deps: { store?: DesignStore; renderFn?: RegenerateStepDeps["renderFn"] } = {}
) {
  const store = deps.store ?? prismaDesignStore;
  await markDesignRegenerating(design, judgeVerdict, { store });
  return runRegenerateStep(design.id, judgeVerdict, { store, renderFn: deps.renderFn });
}

/**
 * Just the "claim this design for regeneration" half of
 * regenerateDesignSibling() above, split out (issue #19) for a caller that
 * needs to enqueue the actual sibling create+render as an async Cloud Tasks
 * step (POST /api/admin/judge-runs/[id]/flagged/[designId]/regenerate,
 * reusing tasks.ts's existing enqueueDesignRegenerate()/
 * /api/tasks/regenerate-design — the same task that already does this
 * render for the live judge/fix/regenerate chain, issue #13) rather than
 * calling runRegenerateStep() — and its default renderFn's real Gemini
 * call — synchronously inside a browser-facing admin request, which risks
 * the same ~60s Firebase Hosting proxy timeout every other route in this
 * repo works around by splitting create-fast from render-slow.
 */
export async function markDesignRegenerating(
  design: Design,
  judgeVerdict: JudgeVerdict,
  deps: { store?: DesignStore } = {}
): Promise<Design> {
  const store = deps.store ?? prismaDesignStore;
  return store.update(design.id, {
    validationStatus: "regenerating",
    validationRegenAttempts: design.validationRegenAttempts + 1,
    validationNotes: summarizeVerdict(judgeVerdict),
  });
}
