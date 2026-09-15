/**
 * Automated validation for issue #18 — scripts/judge-designs.ts's core
 * decision logic, src/lib/judge-designs-runner.ts's judgeOneDesign() /
 * computeExclusion().
 *
 * Deliberately does NOT touch the real (shared prod) Neon DB or spend a
 * real Gemini call: drives judgeOneDesign() against an in-memory fake
 * DesignStore (mirroring scripts/test-validation-chain.ts's
 * FakeDesignStore) with scripted fake judge/audit/style functions injected
 * via `deps` — the same seam validation-chain.ts's tests use.
 *
 * Covers this issue's automated-validation criteria verbatim:
 *   1. Dry run (apply=false) never calls a single store write, for both a
 *      passing and a failing design.
 *   2. --apply: a design that fails color-fitness gets a sibling created,
 *      linked via regeneratedFromDesignId, and the original flips to
 *      "superseded".
 *   3. --apply: a design already attached to a placed Order is reported as
 *      flagged-for-review, not auto-fixed (no sibling, no write at all).
 *   4. --apply: a design that passes as-is flips to "validated" in place.
 *   5. computeExclusion()'s Order/DesignProduct rules.
 *   6. Designs stuck at status "generating" are reported via the
 *      stuck-generation rubric only, and never reach the judge call.
 *
 * Usage: npx tsx scripts/test-judge-designs.ts
 * Exits non-zero if any assertion fails.
 */
import type { Design, Prisma } from "@prisma/client";
import type { JudgeVerdict } from "../src/lib/design-judge";
import type { DesignStore } from "../src/lib/validation-chain";
import type { IntegrityVerdict, StyleVerdict } from "../src/lib/design-judge-bulk";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  [${ok ? "ok" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ── In-memory fake DesignStore (mirrors test-validation-chain.ts's) ────────
class FakeDesignStore implements DesignStore {
  rows = new Map<string, Design>();
  writeCount = 0;
  private nextId = 1;

  seed(id: string, data: Partial<Design>) {
    this.rows.set(id, makeDesign(id, data));
  }

  async findById(id: string) {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async findByRegeneratedFrom(sourceId: string) {
    for (const row of this.rows.values()) {
      if (row.regeneratedFromDesignId === sourceId) return { ...row };
    }
    return null;
  }

  async claim(id: string, expectedStatuses: readonly string[], data: Prisma.DesignUncheckedUpdateInput) {
    this.writeCount++;
    const row = this.rows.get(id);
    if (!row || !expectedStatuses.includes(row.validationStatus)) return null;
    Object.assign(row, data);
    return { ...row };
  }

  async update(id: string, data: Prisma.DesignUncheckedUpdateInput) {
    this.writeCount++;
    const row = this.rows.get(id);
    if (!row) throw new Error(`FakeDesignStore.update: no row ${id}`);
    Object.assign(row, data);
    return { ...row };
  }

  async create(data: Prisma.DesignUncheckedCreateInput) {
    this.writeCount++;
    const id = `sibling-${this.nextId++}`;
    const row = makeDesign(id, data as Partial<Design>);
    this.rows.set(id, row);
    return { ...row };
  }
}

function makeDesign(id: string, data: Partial<Design>): Design {
  return {
    id,
    batchId: "batch-1",
    title: "Test Design",
    phrase: "TEST",
    visualConcept: "A test concept.",
    vibe: null,
    blurb: null,
    backPhrase: null,
    backLayout: "upper-back",
    style: "raster",
    designPrompt: "prompt",
    productPrompt: "product prompt",
    category: "men",
    variantColor: "Black",
    productImagePath: "/generated/product.png",
    designImagePath: "/generated/design.png",
    productPreviewImagePath: null,
    designPreviewImagePath: null,
    backDesignImagePath: null,
    backDesignPreviewImagePath: null,
    designImageData: "ZmFrZQ==",
    designSVGData: null,
    status: "generated",
    errorMessage: null,
    validationStatus: "unjudged",
    validationFixAttempts: 0,
    validationRegenAttempts: 0,
    validationNotes: null,
    regeneratedFromDesignId: null,
    printroveDesignId: null,
    printroveBackDesignId: null,
    slug: null,
    createdByUserId: null,
    createdByAnonId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...data,
  } as Design;
}

function verdict(overrides: Partial<JudgeVerdict>): JudgeVerdict {
  return {
    usable: true,
    issues: [],
    needsRegeneration: false,
    regenerationPrompt: "",
    colorMatchesArt: true,
    fix: "none",
    measuredInkLuminance: 200,
    ...overrides,
  };
}

async function fakeLoadImage(): Promise<string> {
  return "ZmFrZQ==";
}

function fakeRenderFn(design: Design): Promise<Design> {
  return Promise.resolve({ ...design, status: "generated" });
}

const noAudit = async (): Promise<IntegrityVerdict> => {
  throw new Error("auditFn should not be called when canAudit is false");
};
const stubStyleAligned = async (): Promise<StyleVerdict> => ({ aligned: true, violations: [] });

async function main() {
  const { judgeOneDesign, computeExclusion } = await import("../src/lib/judge-designs-runner");

  // ── computeExclusion() ───────────────────────────────────────────────────
  console.log("=== computeExclusion() — Order/DesignProduct rules ===");
  check("no orders, no designProducts -> not excluded", computeExclusion([], []).excluded === false);
  check(
    'only a "pending_payment" order (abandoned checkout) -> not excluded',
    computeExclusion([{ status: "pending_payment" }], []).excluded === false
  );
  check('a "pending" order (COD, placed) -> excluded', computeExclusion([{ status: "pending" }], []).excluded === true);
  check('a "published" order -> excluded', computeExclusion([{ status: "published" }], []).excluded === true);
  check(
    'DesignProduct status "pending", approvalStatus "unreviewed" -> not excluded',
    computeExclusion([], [{ status: "pending", approvalStatus: "unreviewed" }]).excluded === false
  );
  check(
    'DesignProduct status "ready" -> excluded (built Printrove product/mockup)',
    computeExclusion([], [{ status: "ready", approvalStatus: "unreviewed" }]).excluded === true
  );
  check(
    'DesignProduct approvalStatus "approved" -> excluded (live/browsable)',
    computeExclusion([], [{ status: "pending", approvalStatus: "approved" }]).excluded === true
  );

  // ── 1. Dry run never writes ──────────────────────────────────────────────
  console.log("\n=== Dry run (apply=false) never calls a store write ===");
  {
    const store = new FakeDesignStore();
    store.seed("d1", { status: "generated", variantColor: "Black" });
    const failingJudge = async () => verdict({ usable: false, colorMatchesArt: false, fix: "regenerate", issues: ["bad"] });
    const result = await judgeOneDesign(
      (await store.findById("d1"))!,
      { excluded: false, reasons: [] },
      false,
      { store, judgeFn: failingJudge, loadImage: fakeLoadImage, styleFn: stubStyleAligned, canAudit: false }
    );
    check('failing design, dry-run -> outcome "would-create-sibling"', result.outcome === "would-create-sibling", result.outcome);
    check("dry-run made zero store writes", store.writeCount === 0, `writeCount=${store.writeCount}`);
  }
  {
    const store = new FakeDesignStore();
    store.seed("d2", { status: "generated", variantColor: "White" });
    const passingJudge = async () => verdict({ usable: true, colorMatchesArt: true });
    const result = await judgeOneDesign(
      (await store.findById("d2"))!,
      { excluded: false, reasons: [] },
      false,
      { store, judgeFn: passingJudge, loadImage: fakeLoadImage, styleFn: stubStyleAligned, canAudit: false }
    );
    check('passing design, dry-run -> outcome "would-validate"', result.outcome === "would-validate", result.outcome);
    check("dry-run made zero store writes", store.writeCount === 0, `writeCount=${store.writeCount}`);
  }

  // ── 2. --apply: judge failure -> sibling created + linked + superseded ──
  console.log('\n=== --apply: color-fitness failure -> sibling created, linked, original "superseded" ===');
  {
    const store = new FakeDesignStore();
    store.seed("d3", { status: "generated", variantColor: "Black", validationRegenAttempts: 0 });
    const failingJudge = async () =>
      verdict({
        usable: false,
        colorMatchesArt: false,
        fix: "regenerate",
        issues: ["light ink on Black garment"],
        regenerationPrompt: "use dark ink instead",
      });

    const result = await judgeOneDesign(
      (await store.findById("d3"))!,
      { excluded: false, reasons: [] },
      true,
      { store, judgeFn: failingJudge, loadImage: fakeLoadImage, styleFn: stubStyleAligned, canAudit: false, renderFn: fakeRenderFn }
    );

    check('outcome is "sibling-created"', result.outcome === "sibling-created", JSON.stringify(result));
    check("a siblingId was returned", Boolean(result.siblingId), String(result.siblingId));

    const source = await store.findById("d3");
    check('source design ends "superseded"', source?.validationStatus === "superseded");
    check("source validationRegenAttempts incremented to 1", source?.validationRegenAttempts === 1);

    const sibling = await store.findByRegeneratedFrom("d3");
    check("a sibling row exists, linked via regeneratedFromDesignId", Boolean(sibling), JSON.stringify(sibling));
    check("sibling id matches the reported siblingId", sibling?.id === result.siblingId);
    check('sibling carries the same variantColor as the source ("Black")', sibling?.variantColor === "Black");
    check("sibling has empty (not-yet-rendered) image paths", sibling?.designImagePath === "" && sibling?.productImagePath === "");
    check("sibling never carried over Printrove ids", sibling?.printroveDesignId === null && sibling?.printroveBackDesignId === null);
  }

  // ── 3. --apply: order-linked design -> flagged, not auto-fixed ─────────
  console.log("\n=== --apply: design attached to a placed Order -> flagged-for-review, no sibling ===");
  {
    const store = new FakeDesignStore();
    store.seed("d4", { status: "generated", variantColor: "Black" });
    const failingJudge = async () => verdict({ usable: false, colorMatchesArt: false, fix: "relabel", issues: ["mismatch"] });
    const exclusion = { excluded: true, reasons: ["attached to 1 placed Order(s)"] };

    const rowsBefore = store.rows.size;
    const result = await judgeOneDesign((await store.findById("d4"))!, exclusion, true, {
      store,
      judgeFn: failingJudge,
      loadImage: fakeLoadImage,
      styleFn: stubStyleAligned,
      canAudit: false,
    });

    check('outcome is "flagged-for-review"', result.outcome === "flagged-for-review", JSON.stringify(result));
    check("no sibling row was created", store.rows.size === rowsBefore, `rows=${store.rows.size}`);
    check("no store write happened at all", store.writeCount === 0, `writeCount=${store.writeCount}`);
    const source = await store.findById("d4");
    check('source validationStatus untouched ("unjudged")', source?.validationStatus === "unjudged");
  }

  // ── 4. --apply: passing design -> validated in place ────────────────────
  console.log('\n=== --apply: passing design -> "validated" in place, no sibling ===');
  {
    const store = new FakeDesignStore();
    store.seed("d5", { status: "generated", variantColor: "Black" });
    const passingJudge = async () => verdict({ usable: true, colorMatchesArt: true });
    const rowsBefore = store.rows.size;

    const result = await judgeOneDesign((await store.findById("d5"))!, { excluded: false, reasons: [] }, true, {
      store,
      judgeFn: passingJudge,
      loadImage: fakeLoadImage,
      styleFn: stubStyleAligned,
      canAudit: false,
    });

    check('outcome is "validated"', result.outcome === "validated", JSON.stringify(result));
    check("no sibling row was created", store.rows.size === rowsBefore, `rows=${store.rows.size}`);
    const source = await store.findById("d5");
    check('validationStatus flipped to "validated"', source?.validationStatus === "validated");
  }

  // ── 5. Stuck-generation designs never reach the judge call ─────────────
  console.log("\n=== status=\"generating\" (stuck) -> stuck-generation rubric only, judge never called ===");
  {
    const store = new FakeDesignStore();
    const now = new Date("2026-09-15T12:00:00Z");
    store.seed("d6", {
      status: "generating",
      designImagePath: "",
      productImagePath: "",
      updatedAt: new Date("2026-09-15T11:00:00Z"), // 60m old
    });
    let judgeCalls = 0;
    const countingJudge = async () => {
      judgeCalls++;
      return verdict({});
    };

    const result = await judgeOneDesign((await store.findById("d6"))!, { excluded: false, reasons: [] }, true, {
      store,
      judgeFn: countingJudge,
      loadImage: fakeLoadImage,
      styleFn: stubStyleAligned,
      canAudit: false,
      now,
    });

    check('outcome is "skipped"', result.outcome === "skipped", JSON.stringify(result));
    check("verdict.stuck is true", result.verdict.stuck === true);
    check("judge was never called for a still-generating design", judgeCalls === 0);
    check("no store write happened", store.writeCount === 0, `writeCount=${store.writeCount}`);
  }

  // ── 6. canAudit=false never calls auditFn ────────────────────────────────
  console.log("\n=== canAudit=false skips the integrity check entirely (no GCS_BUCKET) ===");
  {
    const store = new FakeDesignStore();
    store.seed("d7", { status: "generated", variantColor: "Black" });
    const passingJudge = async () => verdict({ usable: true, colorMatchesArt: true });

    const result = await judgeOneDesign((await store.findById("d7"))!, { excluded: false, reasons: [] }, false, {
      store,
      judgeFn: passingJudge,
      loadImage: fakeLoadImage,
      styleFn: stubStyleAligned,
      auditFn: noAudit, // throws if ever called
      canAudit: false,
    });
    check("integrity verdict is undefined (skipped, not run)", result.verdict.integrity === undefined);
    check('outcome is "would-validate" (auditFn never threw)', result.outcome === "would-validate");
  }

  // ── 7. integrityDetail distinguishes a genuine loss from a legacy row ───
  console.log("\n=== integrityDetail distinguishes hasLostObjects from hasMissingFields ===");
  {
    const store = new FakeDesignStore();
    store.seed("d8", { status: "generated", variantColor: "Black" });
    const passingJudge = async () => verdict({ usable: true, colorMatchesArt: true });
    const legacyAudit = async (): Promise<IntegrityVerdict> => ({
      passed: false,
      checks: [],
      issues: ["back design image missing"],
      hasLostObjects: false,
      hasMissingFields: true,
    });

    const result = await judgeOneDesign((await store.findById("d8"))!, { excluded: false, reasons: [] }, false, {
      store,
      judgeFn: passingJudge,
      loadImage: fakeLoadImage,
      styleFn: stubStyleAligned,
      auditFn: legacyAudit,
      canAudit: true,
    });
    check(
      "a legacy (missing-field-only) row reports hasMissingFields, not hasLostObjects",
      result.integrityDetail?.hasMissingFields === true && result.integrityDetail?.hasLostObjects === false,
      JSON.stringify(result.integrityDetail)
    );
  }
  {
    const store = new FakeDesignStore();
    store.seed("d9", { status: "generated", variantColor: "Black" });
    const passingJudge = async () => verdict({ usable: true, colorMatchesArt: true });
    const realLossAudit = async (): Promise<IntegrityVerdict> => ({
      passed: false,
      checks: [],
      issues: ["front design image not found in GCS"],
      hasLostObjects: true,
      hasMissingFields: false,
    });

    const result = await judgeOneDesign((await store.findById("d9"))!, { excluded: false, reasons: [] }, false, {
      store,
      judgeFn: passingJudge,
      loadImage: fakeLoadImage,
      styleFn: stubStyleAligned,
      auditFn: realLossAudit,
      canAudit: true,
    });
    check(
      "a genuine loss reports hasLostObjects, not hasMissingFields",
      result.integrityDetail?.hasLostObjects === true && result.integrityDetail?.hasMissingFields === false,
      JSON.stringify(result.integrityDetail)
    );
  }

  // ── 8. A render failure is reported distinctly, not folded into a clean success
  console.log('\n=== --apply: sibling render failure -> distinct "sibling-created-render-failed" outcome ===');
  {
    const store = new FakeDesignStore();
    store.seed("d10", { status: "generated", variantColor: "Black" });
    const failingJudge = async () => verdict({ usable: false, colorMatchesArt: false, fix: "regenerate", issues: ["bad"] });
    const failingRenderFn = async (): Promise<Design> => {
      throw new Error("simulated Gemini render failure");
    };

    const result = await judgeOneDesign((await store.findById("d10"))!, { excluded: false, reasons: [] }, true, {
      store,
      judgeFn: failingJudge,
      loadImage: fakeLoadImage,
      styleFn: stubStyleAligned,
      canAudit: false,
      renderFn: failingRenderFn,
    });

    check(
      'outcome is "sibling-created-render-failed", distinct from a clean "sibling-created"',
      result.outcome === "sibling-created-render-failed",
      JSON.stringify(result)
    );
    check("a sibling row still exists (and the original is still superseded)", Boolean(result.siblingId));
    const source = await store.findById("d10");
    check('source still ends "superseded" even though the render failed', source?.validationStatus === "superseded");
  }

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("ERROR", err);
  process.exitCode = 1;
});
