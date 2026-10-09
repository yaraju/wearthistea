/**
 * Bulk-only judge extensions (issue #17) — a sibling to design-judge.ts's
 * judgeDesign() (issue #12, color-fitness + garment-in-graphic), which
 * every judge run (live or bulk) shares. This module adds the checks that
 * only make sense as part of a bulk sweep over existing rows:
 *
 *   - integrity audit: do the six stored path fields on a Design actually
 *     point at real GCS objects, not local-disk-only or missing entirely.
 *   - style-alignment re-check: does phrase/visualConcept/backPhrase still
 *     satisfy the exact BRAND_VOICE/CONCEPT_RULES/ART_RULES constants used
 *     at generation time.
 *   - stuck-generation sweep: designs sitting at status "generating" past a
 *     staleness threshold, flagged and (opt-in) regenerated via the same
 *     sibling-creation pattern as /api/admin/designs/[id]/regenerate/route.ts.
 *   - per-rubric reporting: named pass-percentage rubrics — color-fitness,
 *     garment-in-graphic, integrity, style-alignment, stuck-generation —
 *     mirroring scripts/eval-designs.ts's SUMMARY block style.
 *
 * The bulk CLI runner that will actually drive these against every row
 * (issue #18) and the Cloud Tasks queue chain (issue #13) don't exist yet —
 * this module only needs to expose correct, independently-testable
 * building blocks for them to call.
 */
import type { Design } from "@prisma/client";
import { ai } from "./gemini";
import { existsInGcs, hasDurableStorage, assertDesignPathFieldsShape } from "./storage";
import { prompts, BRAND_VOICE, CONCEPT_RULES, ART_RULES } from "@/config/prompts";
import { settings } from "@/config/settings";
import type { JudgeVerdict } from "./design-judge";

// ─────────────────────────────────────────────────────────────────────────
// Integrity audit
// ─────────────────────────────────────────────────────────────────────────

/** The six stored-artwork path fields every generated Design should have —
 * see prisma/schema.prisma's Design model. */
export type IntegrityCheckableDesign = Pick<
  Design,
  | "designImagePath"
  | "backDesignImagePath"
  | "productImagePath"
  | "designPreviewImagePath"
  | "productPreviewImagePath"
  | "backDesignPreviewImagePath"
>;

const INTEGRITY_FIELDS: Array<{ field: keyof IntegrityCheckableDesign; label: string }> = [
  { field: "designImagePath", label: "front design image" },
  { field: "backDesignImagePath", label: "back design image" },
  { field: "productImagePath", label: "product mockup image" },
  { field: "designPreviewImagePath", label: "design preview" },
  { field: "productPreviewImagePath", label: "product preview" },
  { field: "backDesignPreviewImagePath", label: "back design preview" },
];

export interface IntegrityFieldCheck {
  field: keyof IntegrityCheckableDesign;
  label: string;
  path: string | null;
  /** False when the field itself is null/empty — checked before ever
   * touching GCS. */
  present: boolean;
  /** True/false once checked; null when skipped because the field wasn't
   * present in the first place. */
  existsInGcs: boolean | null;
}

export interface IntegrityVerdict {
  /** Strict pass: ALL SIX path fields set AND resolved in GCS, exactly as
   * the issue specifies. NOTE this counts a legacy row that simply
   * predates a feature (e.g. backDesignImagePath on a design created
   * before back-print support — see schema.prisma's backPhrase comment:
   * "Nullable so pre-migration rows don't need a backfill") as a fail, the
   * same as a genuinely lost file. Callers that need to tell those apart
   * (a bulk runner deciding what to regenerate, a report that shouldn't
   * read as "half the catalog is broken") should key off
   * `hasLostObjects`/`hasMissingFields` below instead of `passed` alone. */
  passed: boolean;
  checks: IntegrityFieldCheck[];
  issues: string[];
  /** True when at least one path field IS set but the object doesn't exist
   * in GCS — a genuine loss (matches the exact incident this helper exists
   * to catch: a DB path pointing at a file that only ever existed on local
   * disk). This is the signal actually worth regenerating/re-uploading
   * over. */
  hasLostObjects: boolean;
  /** True when at least one path field was never set at all
   * (`present: false`) — usually a legacy pre-feature row, not corruption.
   * Worth surfacing separately from hasLostObjects so a report doesn't
   * conflate "never had this" with "used to have this, now it's gone". */
  hasMissingFields: boolean;
}

/**
 * Audits all six of a Design's stored-artwork path fields: present (non-
 * null/non-empty) and resolves to a real GCS object, not local-disk-only.
 *
 * `existsFn` defaults to storage.ts's existsInGcs but is injectable — unit
 * tests pass a stub so this never needs real GCS credentials to verify the
 * presence/absence logic (see scripts/test-design-judge-bulk.ts).
 *
 * When called with the DEFAULT existsFn (i.e. a real run, not an injected
 * test stub), this REFUSES to run at all — throws — unless
 * storage.ts's hasDurableStorage is true (GCS_BUCKET configured). Without
 * that guard, an accidentally-unset GCS_BUCKET on a real run would make
 * existsInGcs() report every path "not found in GCS" (its documented,
 * correct behavior when unconfigured — see storage.ts) and this function
 * would silently turn that into "every design has lost artwork," which a
 * bulk runner could then write to production rows as if it were a real
 * finding. See AGENTS.md's GCS_BUCKET gotcha and the real incident it
 * documents (127 rows reverted after exactly this class of silent
 * local-disk fallback).
 */
export async function auditDesignIntegrity(
  design: IntegrityCheckableDesign,
  existsFn: (publicPath: string) => Promise<boolean> = existsInGcs
): Promise<IntegrityVerdict> {
  if (existsFn === existsInGcs && !hasDurableStorage) {
    throw new Error(
      "auditDesignIntegrity(): GCS_BUCKET is not configured (storage.ts's hasDurableStorage is false) — " +
        "refusing to run with the real existsInGcs(), since every path would come back \"not found in GCS\" " +
        "and be mistaken for lost artwork rather than \"there's nothing configured to check against\". " +
        "Pass GCS_BUCKET explicitly on the command line, or inject a custom existsFn for tests."
    );
  }

  const checks: IntegrityFieldCheck[] = [];
  const issues: string[] = [];

  for (const { field, label } of INTEGRITY_FIELDS) {
    const path = design[field];
    if (!path) {
      checks.push({ field, label, path: null, present: false, existsInGcs: null });
      issues.push(`${label} missing (${field} is not set)`);
      continue;
    }
    const exists = await existsFn(path);
    checks.push({ field, label, path, present: true, existsInGcs: exists });
    if (!exists) {
      issues.push(`${label} (${field}=${path}) not found in GCS — local-disk-only or lost`);
    }
  }

  const hasMissingFields = checks.some((c) => !c.present);
  const hasLostObjects = checks.some((c) => c.present && c.existsInGcs === false);

  return { passed: issues.length === 0, checks, issues, hasLostObjects, hasMissingFields };
}

// ─────────────────────────────────────────────────────────────────────────
// Style-alignment re-check
// ─────────────────────────────────────────────────────────────────────────

export type StyleCheckableDesign = Pick<Design, "phrase" | "visualConcept" | "backPhrase">;

export interface StyleVerdict {
  aligned: boolean;
  violations: string[];
}

/** Real Gemini call — same call shape as design-judge.ts's judgeDesign(),
 * using prompts.styleAlignmentReview() (which embeds the exact BRAND_VOICE/
 * CONCEPT_RULES/ART_RULES constants, not a redefinition — see that prompt's
 * doc comment). No offline fallback here either, for the same reason
 * judgeDesign() has none: a check that silently "passes" everything when
 * GEMINI_API_KEY is unset would be a false-validate a bulk runner could
 * write to every row. */
async function geminiStyleReview(design: StyleCheckableDesign): Promise<StyleVerdict> {
  const res = await ai().models.generateContent({
    model: settings.gemini.textModel,
    contents: [{ role: "user", parts: [{ text: prompts.styleAlignmentReview(design) }] }],
    config: {
      responseMimeType: "application/json",
      responseSchema: prompts.styleAlignmentSchema as unknown as Record<string, unknown>,
      temperature: 0,
    },
  });

  const text = res.text;
  if (!text) throw new Error("Style-alignment judge returned no text.");

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Style-alignment judge returned non-JSON: ${text.slice(0, 200)}…`);
  }

  const violations = Array.isArray(parsed.violations)
    ? parsed.violations.filter((v): v is string => typeof v === "string")
    : [];
  const aligned = typeof parsed.aligned === "boolean" ? parsed.aligned : violations.length === 0;

  return { aligned, violations };
}

/**
 * Default style review. With DECISION_STYLE_REVIEW=jev the text-only check
 * goes to Jev (measured: same 100% accuracy on 36 labeled concepts, ~95%
 * faster, ~98% cheaper per call); any Jev error falls back to Gemini so a
 * Jev outage never blocks the bulk runner. Jev returns a single violation
 * flag, so `violations` is generic; use "gemini" when the detail matters.
 */
async function defaultStyleReview(design: StyleCheckableDesign): Promise<StyleVerdict> {
  if (settings.decision.styleReview === "jev" && process.env.TYPESAFE_API_KEY) {
    const { jevStyleReview } = await import("./decision/jev");
    const rules = [
      BRAND_VOICE,
      CONCEPT_RULES,
      ART_RULES,
      "NOTE: ART_RULES governs rendered pixels. Only flag visualConcept against ART_RULES if it explicitly INSTRUCTS drawing a prohibited element (logo, copyrighted character, meme screenshot, signature/watermark); merely describing a genre or aesthetic is fine. A missing backPhrase is not a violation.",
    ].join("\n\n");
    const r = await jevStyleReview(design, rules);
    if (r.value) return { aligned: r.value.aligned, violations: r.value.violations };
    console.warn(`[style-review] Jev failed (${r.error}); falling back to Gemini`);
  }
  return geminiStyleReview(design);
}

/**
 * Re-validates phrase/visualConcept/backPhrase against the same rules used
 * at generation time. `reviewFn` is injectable (defaults to the real
 * Gemini call above) — same DI pattern as design-versions.ts's ChildLookup,
 * so unit tests can substitute a deterministic stub instead of a real API
 * call, or the real path can be exercised end-to-end against a fixture that
 * clearly violates CONCEPT_RULES (e.g. an over-length phrase) the same way
 * scripts/test-design-judge.ts exercises judgeDesign() for real.
 */
export async function checkStyleAlignment(
  design: StyleCheckableDesign,
  reviewFn: (design: StyleCheckableDesign) => Promise<StyleVerdict> = defaultStyleReview
): Promise<StyleVerdict> {
  return reviewFn(design);
}

// ─────────────────────────────────────────────────────────────────────────
// Stuck-generation sweep
// ─────────────────────────────────────────────────────────────────────────

/**
 * Staleness threshold for status "generating": 30 minutes. Chosen because
 * the full render pipeline (Gemini art + product mockup composite + back
 * print, see design-render.ts's renderDesignArtwork) normally completes in
 * well under a minute per scripts/eval-designs.ts / test-fulfillment.ts
 * runs, and even a slow multi-retry Gemini 503/429 backoff sequence
 * shouldn't plausibly run past single-digit minutes — 30 minutes gives a
 * wide safety margin against a merely-slow-but-still-working request before
 * concluding the row is actually abandoned (e.g. the process that was
 * rendering it crashed/was redeployed mid-request, the one failure mode
 * that leaves a row stuck at "generating" forever with nothing to retry
 * it).
 */
export const STUCK_GENERATION_THRESHOLD_MINUTES = 30;

export type StuckCheckableDesign = Pick<Design, "id" | "status" | "updatedAt">;

/** Pure predicate — no I/O. `now`/`thresholdMinutes` are overridable so
 * tests don't depend on wall-clock time. */
export function isStuckGenerating(
  design: StuckCheckableDesign,
  now: Date = new Date(),
  thresholdMinutes: number = STUCK_GENERATION_THRESHOLD_MINUTES
): boolean {
  if (design.status !== "generating") return false;
  const ageMs = now.getTime() - design.updatedAt.getTime();
  return ageMs > thresholdMinutes * 60 * 1000;
}

export interface StuckGenerationResult {
  designId: string;
  ageMinutes: number;
  /** "flagged": detected stuck, no write performed (dryRun, the default).
   * "triggered": a fresh sibling Design was created and rendered.
   * "not-stuck": design didn't actually meet the staleness threshold.
   * "error": triggering failed — the original row is left untouched. */
  action: "flagged" | "triggered" | "not-stuck" | "error";
  siblingId?: string;
  error?: string;
}

/**
 * Flags a stuck design and, only when `dryRun` is explicitly set to false,
 * triggers a real fix: creates a fresh sibling Design row (same
 * regeneratedFromDesignId-linked shape as
 * /api/admin/designs/[id]/regenerate/route.ts's sibling-creation — the
 * original stuck row is left in place for audit/comparison, never mutated
 * in place, since its own artwork paths are empty and there's nothing
 * there worth re-rendering into), marks the original row "failed" so it
 * stops reporting as perpetually "generating", and renders the sibling
 * directly via design-render.ts's renderDesignArtwork — mirroring
 * scripts/regenerate-failed-designs.ts's direct-render precedent, since a
 * headless sweep has no admin client to hand the follow-up POST
 * /api/generate/retry off to.
 *
 * Defaults to dryRun: true (report-only). This touches the same production
 * DB as the live app and costs a real Gemini render — per this issue's
 * safety requirement, an accidental default-on sweep must never fire; a
 * caller has to opt in explicitly.
 */
export async function flagAndTriggerStuckDesign(
  design: Design,
  opts: {
    dryRun?: boolean;
    thresholdMinutes?: number;
    now?: Date;
  } = {}
): Promise<StuckGenerationResult> {
  const now = opts.now ?? new Date();
  const thresholdMinutes = opts.thresholdMinutes ?? STUCK_GENERATION_THRESHOLD_MINUTES;
  const ageMinutes = Math.round((now.getTime() - design.updatedAt.getTime()) / 60000);

  if (!isStuckGenerating(design, now, thresholdMinutes)) {
    return { designId: design.id, ageMinutes, action: "not-stuck" };
  }

  if (opts.dryRun !== false) {
    return { designId: design.id, ageMinutes, action: "flagged" };
  }

  const { prisma } = await import("./prisma");
  // Declared outside the try so the outer catch can still see (and clean
  // up) a sibling that was successfully created but then failed to render —
  // without this, a render failure here would silently leave a second row
  // stuck at "generating" forever, i.e. this sweep manufacturing the exact
  // pathology it exists to clear.
  let sibling: Design | undefined;

  try {
    const { renderDesignArtwork } = await import("./design-render");
    const { designSlug } = await import("./slug");
    const { langfuse } = await import("./langfuse");
    const { Prisma } = await import("@prisma/client");

    try {
      // Always "" here (art renders later, via renderDesignArtwork below),
      // which the guard always passes — wired anyway so this stays guarded
      // if a future edit ever computes a real path at this call site
      // instead. See storage.ts's assertDesignPathFieldsShape.
      const siblingPathFields = {
        designImagePath: "",
        productImagePath: "",
        designPreviewImagePath: "",
        productPreviewImagePath: "",
      };
      assertDesignPathFieldsShape(siblingPathFields);
      sibling = await prisma.design.create({
        data: {
          batchId: design.batchId,
          title: design.title,
          phrase: design.phrase,
          visualConcept: design.visualConcept,
          vibe: design.vibe,
          blurb: design.blurb,
          backPhrase: design.backPhrase,
          backLayout: design.backLayout,
          style: design.style,
          designPrompt: design.designPrompt,
          productPrompt: design.productPrompt,
          category: design.category,
          variantColor: design.variantColor,
          ...siblingPathFields,
          status: "generating",
          regeneratedFromDesignId: design.id,
        },
      });
    } catch (err) {
      // Same @unique guard as the admin regenerate route: a second sweep
      // pass over the same stuck row (e.g. re-run before the original got
      // marked "failed") hits this instead of creating a duplicate sibling.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002" &&
        (err.meta?.target as string[] | undefined)?.includes("regeneratedFromDesignId")
      ) {
        const existing = await prisma.design.findUnique({ where: { regeneratedFromDesignId: design.id } });
        return {
          designId: design.id,
          ageMinutes,
          action: "error",
          error: `Already regenerated once (sibling ${existing?.id ?? "unknown"}).`,
        };
      }
      throw err;
    }

    await prisma.design.update({
      where: { id: design.id },
      data: {
        status: "failed",
        errorMessage: `Stuck at "generating" for ~${ageMinutes}m — superseded by sibling ${sibling.id} via stuck-generation sweep.`,
      },
    });

    const slug = designSlug(sibling.title, sibling.id);
    await prisma.design.update({ where: { id: sibling.id }, data: { slug } }).catch(() => {});

    const trace = langfuse.trace({
      name: "stuck-generation-sweep",
      input: { designId: design.id, siblingId: sibling.id },
    });
    const rateLimit = {
      ok: true,
      tier: "admin" as const,
      bucketKey: "ratelimit:generate:script:stuck-sweep",
      windowMs: 60 * 60 * 1000,
      limit: Number.MAX_SAFE_INTEGER,
    };
    await renderDesignArtwork(sibling, trace, rateLimit);

    return { designId: design.id, ageMinutes, action: "triggered", siblingId: sibling.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Mirrors regenerate-failed-designs.ts's precedent: a transient
    // provider error (Gemini 429/503) leaves the sibling at "generating"
    // so a later retry (a future sweep pass, or /api/generate/retry) can
    // pick it back up; anything else marks it "failed" so it never sits
    // around as a second stuck-forever row for this same sweep to loop on.
    if (sibling) {
      try {
        const { isTransientProviderError } = await import("./design-render");
        if (!isTransientProviderError(err)) {
          await prisma.design.update({
            where: { id: sibling.id },
            data: { status: "failed", errorMessage: message },
          });
        }
      } catch {
        // Best-effort cleanup only — the original error is what we report.
      }
    }

    return { designId: design.id, ageMinutes, action: "error", error: message, siblingId: sibling?.id };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Per-rubric reporting — mirrors scripts/eval-designs.ts's SUMMARY block
// ─────────────────────────────────────────────────────────────────────────

export type RubricName =
  | "color-fitness"
  | "garment-in-graphic"
  | "integrity"
  | "style-alignment"
  | "stuck-generation";

export interface RubricResult {
  name: RubricName;
  passed: number;
  total: number;
}

/** Per-design verdicts collected by a bulk runner (issue #18) — every field
 * is optional since not every check necessarily runs against every design
 * in a given pass (e.g. a design already known "generated" never goes
 * through the stuck-generation check). buildRubricReport() only counts a
 * rubric over the designs that actually carry a verdict for it. */
export interface BulkDesignVerdict {
  designId: string;
  /** design-judge.ts's judgeDesign() output — feeds both the color-fitness
   * (colorMatchesArt) and garment-in-graphic (usable) rubrics. */
  judge?: Pick<JudgeVerdict, "colorMatchesArt" | "usable">;
  integrity?: Pick<IntegrityVerdict, "passed">;
  style?: Pick<StyleVerdict, "aligned">;
  /** true = flagged as stuck (a "fail" for this rubric), false = healthy. */
  stuck?: boolean;
}

/** Builds the five named rubrics' pass/total counts from a batch of
 * per-design verdicts — the shape formatRubricSummary() below prints. */
export function buildRubricReport(verdicts: BulkDesignVerdict[]): RubricResult[] {
  const withJudge = verdicts.filter((v): v is BulkDesignVerdict & { judge: NonNullable<BulkDesignVerdict["judge"]> } =>
    Boolean(v.judge)
  );
  const withIntegrity = verdicts.filter(
    (v): v is BulkDesignVerdict & { integrity: NonNullable<BulkDesignVerdict["integrity"]> } => Boolean(v.integrity)
  );
  const withStyle = verdicts.filter(
    (v): v is BulkDesignVerdict & { style: NonNullable<BulkDesignVerdict["style"]> } => Boolean(v.style)
  );
  const withStuck = verdicts.filter((v) => v.stuck !== undefined);

  return [
    {
      name: "color-fitness",
      total: withJudge.length,
      passed: withJudge.filter((v) => v.judge.colorMatchesArt).length,
    },
    {
      name: "garment-in-graphic",
      total: withJudge.length,
      passed: withJudge.filter((v) => v.judge.usable).length,
    },
    {
      name: "integrity",
      total: withIntegrity.length,
      passed: withIntegrity.filter((v) => v.integrity.passed).length,
    },
    {
      name: "style-alignment",
      total: withStyle.length,
      passed: withStyle.filter((v) => v.style.aligned).length,
    },
    {
      name: "stuck-generation",
      total: withStuck.length,
      passed: withStuck.filter((v) => !v.stuck).length,
    },
  ];
}

/** Renders a SUMMARY block in scripts/eval-designs.ts's style — one line per
 * named rubric, "passed/total (pct%)", skipping rubrics nothing ran
 * against (total === 0) rather than printing a misleading "0/0 (0%)". */
export function formatRubricSummary(rubrics: RubricResult[]): string {
  const lines = [`=== SUMMARY (rubrics=${rubrics.length}) ===`];
  for (const r of rubrics) {
    if (r.total === 0) {
      lines.push(`${r.name}: no designs checked`);
      continue;
    }
    const pct = ((r.passed / r.total) * 100).toFixed(0);
    lines.push(`${r.name}: ${r.passed}/${r.total} (${pct}%)`);
  }
  return lines.join("\n");
}
