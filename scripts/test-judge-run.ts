/**
 * Automated validation for issue #19 — src/lib/judge-run.ts's core
 * run-tracking logic (createJudgeRun/advanceJudgeRun/prepareFlaggedRegeneration/
 * rejectModeChange/getJudgeRunRubrics), the admin bulk judge-run panel built
 * on top of scripts/judge-designs.ts's shared judgeOneDesign() core (#18).
 *
 * Deliberately does NOT touch the real (shared prod) Neon DB, spend a real
 * Gemini call, or hit a real Cloud Tasks queue: drives createJudgeRun()/
 * advanceJudgeRun() against in-memory fake JudgeRunStore/DesignStore
 * implementations (mirroring scripts/test-judge-designs.ts's
 * FakeDesignStore) with scripted fake judge functions injected via
 * judgeDeps — the same seam judge-designs-runner.ts's own tests use.
 *
 * Covers this issue's automated-validation criteria:
 *   1. Starting a run: scopes+snapshots the exact design ids, a zero-design
 *      scope completes immediately with nothing to advance.
 *   2. Polling progress: advanceJudgeRun() processes designs one at a time,
 *      accumulating outcomeCounts/verdicts/flagged and rubric pass rates as
 *      it goes, and reports done:true once the run's total is reached.
 *   3. The auto/manual toggle can never be changed once a run exists:
 *      rejectModeChange() — PATCH /api/admin/judge-runs/[id]'s entire body —
 *      always 409s, and advanceJudgeRun() always derives its apply/no-apply
 *      behavior from the run row's OWN persisted `mode`, never from
 *      anything a caller passes in.
 *   4. Manual mode never auto-fixes: every judge failure (excluded or not)
 *      is recorded in `flagged` with zero Design store writes; auto mode's
 *      own sibling-creation/validation writes are unchanged from #18.
 *
 * Usage: npx tsx scripts/test-judge-run.ts
 * Exits non-zero if any assertion fails.
 */
import type { Design, Prisma } from "@prisma/client";
import type { JudgeVerdict } from "../src/lib/design-judge";
import type { DesignStore } from "../src/lib/validation-chain";
import type { JudgeRunRecord, JudgeRunStore, ScopedDesign } from "../src/lib/judge-run";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  [${ok ? "ok" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ── In-memory fake DesignStore (mirrors test-judge-designs.ts's) ───────────
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
    for (const row of this.rows.values()) if (row.regeneratedFromDesignId === sourceId) return { ...row };
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
    title: `Design ${id}`,
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

// ── In-memory fake JudgeRunStore ────────────────────────────────────────
class FakeJudgeRunStore implements JudgeRunStore {
  rows = new Map<string, JudgeRunRecord>();
  private nextId = 1;
  advanceCalls = 0;

  async create(data: Omit<JudgeRunRecord, "id">) {
    const id = `run-${this.nextId++}`;
    const row: JudgeRunRecord = { id, ...data };
    this.rows.set(id, row);
    return { ...row };
  }
  async findById(id: string) {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }
  async findMany(limit: number) {
    return [...this.rows.values()]
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
  async advance(id: string, expectedProcessed: number, patch: Partial<Omit<JudgeRunRecord, "id">>) {
    this.advanceCalls++;
    const row = this.rows.get(id);
    if (!row || row.processed !== expectedProcessed) return null;
    Object.assign(row, patch);
    return { ...row };
  }
  async update(id: string, patch: Partial<Omit<JudgeRunRecord, "id">>) {
    const row = this.rows.get(id);
    if (!row) throw new Error(`FakeJudgeRunStore.update: no row ${id}`);
    Object.assign(row, patch);
    return { ...row };
  }
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
const stubStyleAligned = async () => ({ aligned: true, violations: [] as string[] });

async function main() {
  const { createJudgeRun, advanceJudgeRun, prepareFlaggedRegeneration, rejectModeChange, getJudgeRunRubrics } =
    await import("../src/lib/judge-run");

  // ── 1. createJudgeRun snapshots ids; zero-design scope completes immediately
  console.log("=== createJudgeRun() ===");
  {
    const store = new FakeJudgeRunStore();
    const run = await createJudgeRun(
      { mode: "manual", statusFilter: "unjudged", limit: 5, createdByEmail: "yaraju@gmail.com" },
      { store, scopeFn: async () => ["d1", "d2", "d3"] }
    );
    check("total matches scoped ids", run.total === 3, String(run.total));
    check('status "running" for a non-empty scope', run.status === "running");
    check("designIds snapshotted verbatim, in order", run.designIds === JSON.stringify(["d1", "d2", "d3"]));
    check("mode persisted as requested", run.mode === "manual");
  }
  {
    const store = new FakeJudgeRunStore();
    const run = await createJudgeRun(
      { mode: "auto", statusFilter: "unjudged", limit: 5 },
      { store, scopeFn: async () => [] }
    );
    check('zero-design scope -> status "completed" immediately', run.status === "completed");
    check("completedAt is set", run.completedAt !== null);
  }

  // ── 2. advanceJudgeRun processes one design per call, accumulates state ──
  console.log("\n=== advanceJudgeRun() — manual mode never auto-fixes ===");
  {
    const runStore = new FakeJudgeRunStore();
    const designStore = new FakeDesignStore();
    designStore.seed("d1", { status: "generated", variantColor: "Black" });
    designStore.seed("d2", { status: "generated", variantColor: "White" });

    const run = await runStore.create({
      mode: "manual",
      statusFilter: "unjudged",
      limit: 5,
      status: "running",
      designIds: JSON.stringify(["d1", "d2"]),
      total: 2,
      processed: 0,
      outcomeCounts: "{}",
      verdicts: "[]",
      flagged: "[]",
      error: null,
      startedAt: new Date(),
      completedAt: null,
      createdByEmail: null,
    });

    const scoped = async (id: string): Promise<ScopedDesign | null> => {
      const d = await designStore.findById(id);
      if (!d) return null;
      return { ...d, orders: [], designProducts: [] };
    };
    const failingJudge = async () => verdict({ usable: false, colorMatchesArt: false, issues: ["bad ink"] });
    const passingJudge = async () => verdict({ usable: true, colorMatchesArt: true });

    // d1: fails -> manual mode must NOT create a sibling or write anything.
    const r1 = await advanceJudgeRun(run.id, {
      store: runStore,
      loadDesign: scoped,
      judgeDeps: { store: designStore, judgeFn: failingJudge, loadImage: fakeLoadImage, styleFn: stubStyleAligned, canAudit: false, renderFn: fakeRenderFn },
    });
    check("step 1 not done yet (1/2 processed)", r1.done === false, JSON.stringify(r1));
    check('step 1 outcome "would-create-sibling"', r1.outcome === "would-create-sibling", r1.outcome);
    check("manual mode made zero Design store writes", designStore.writeCount === 0, `writeCount=${designStore.writeCount}`);

    // d2: passes -> manual mode must NOT write "validated" either (apply=false).
    const r2 = await advanceJudgeRun(run.id, {
      store: runStore,
      loadDesign: scoped,
      judgeDeps: { store: designStore, judgeFn: passingJudge, loadImage: fakeLoadImage, styleFn: stubStyleAligned, canAudit: false },
    });
    check("step 2 IS done (2/2 processed)", r2.done === true, JSON.stringify(r2));
    check("still zero Design store writes after a passing design too", designStore.writeCount === 0);

    const finalRun = await runStore.findById(run.id);
    check('run status "completed"', finalRun?.status === "completed");
    check("processed reached total", finalRun?.processed === 2);

    const flagged = JSON.parse(finalRun!.flagged);
    check("exactly one flagged entry (the failing design)", flagged.length === 1, JSON.stringify(flagged));
    check("flagged entry carries the full judgeVerdict for a later manual regenerate", Boolean(flagged[0]?.verdict?.issues), JSON.stringify(flagged[0]));
    check("flagged entry has no siblingId yet (nothing auto-created)", flagged[0]?.siblingId === undefined);

    const rubrics = getJudgeRunRubrics(finalRun!);
    const colorFitness = rubrics.find((r) => r.name === "color-fitness")!;
    check("rubrics recomputed correctly from accumulated verdicts", colorFitness.total === 2 && colorFitness.passed === 1, JSON.stringify(colorFitness));
  }

  // ── 3. auto mode DOES auto-fix, and derives `apply` from the persisted row ─
  console.log("\n=== advanceJudgeRun() — auto mode auto-fixes; apply always comes from run.mode ===");
  {
    const runStore = new FakeJudgeRunStore();
    const designStore = new FakeDesignStore();
    designStore.seed("d1", { status: "generated", variantColor: "Black", validationRegenAttempts: 0 });

    const run = await runStore.create({
      mode: "auto",
      statusFilter: "unjudged",
      limit: 5,
      status: "running",
      designIds: JSON.stringify(["d1"]),
      total: 1,
      processed: 0,
      outcomeCounts: "{}",
      verdicts: "[]",
      flagged: "[]",
      error: null,
      startedAt: new Date(),
      completedAt: null,
      createdByEmail: null,
    });

    const scoped = async (id: string): Promise<ScopedDesign | null> => {
      const d = await designStore.findById(id);
      if (!d) return null;
      return { ...d, orders: [], designProducts: [] };
    };
    const failingJudge = async () =>
      verdict({ usable: false, colorMatchesArt: false, fix: "regenerate", issues: ["light ink on Black"], regenerationPrompt: "use dark ink" });

    // Note: no way to even express "mode" in judgeDeps — advanceJudgeRun's
    // `apply` can ONLY come from the persisted run.mode, structurally.
    const result = await advanceJudgeRun(run.id, {
      store: runStore,
      loadDesign: scoped,
      judgeDeps: { store: designStore, judgeFn: failingJudge, loadImage: fakeLoadImage, styleFn: stubStyleAligned, canAudit: false, renderFn: fakeRenderFn },
    });

    check("auto mode: done after 1 design", result.done === true);
    check('auto mode outcome "sibling-created"', result.outcome === "sibling-created", result.outcome);
    check("auto mode DID write to the Design store (validationStatus + sibling create)", designStore.writeCount > 0, `writeCount=${designStore.writeCount}`);

    const source = await designStore.findById("d1");
    check('source ends "superseded"', source?.validationStatus === "superseded");
    const sibling = await designStore.findByRegeneratedFrom("d1");
    check("a sibling row was actually created", Boolean(sibling));

    const finalRun = await runStore.findById(run.id);
    const flagged = JSON.parse(finalRun!.flagged);
    check('a clean "sibling-created" is NOT added to flagged (no admin attention needed)', flagged.length === 0, JSON.stringify(flagged));
  }

  // ── 4. Excluded designs are flagged in EITHER mode, never auto-fixed ─────
  console.log("\n=== advanceJudgeRun() — an excluded design is flagged even in auto mode ===");
  {
    const runStore = new FakeJudgeRunStore();
    const designStore = new FakeDesignStore();
    designStore.seed("d1", { status: "generated", variantColor: "Black" });

    const run = await runStore.create({
      mode: "auto",
      statusFilter: "unjudged",
      limit: 5,
      status: "running",
      designIds: JSON.stringify(["d1"]),
      total: 1,
      processed: 0,
      outcomeCounts: "{}",
      verdicts: "[]",
      flagged: "[]",
      error: null,
      startedAt: new Date(),
      completedAt: null,
      createdByEmail: null,
    });

    // A placed order ("pending") makes computeExclusion() exclude it.
    const scoped = async (id: string): Promise<ScopedDesign | null> => {
      const d = await designStore.findById(id);
      if (!d) return null;
      return { ...d, orders: [{ status: "pending" }], designProducts: [] };
    };
    const failingJudge = async () => verdict({ usable: false, colorMatchesArt: false, issues: ["bad"] });

    const result = await advanceJudgeRun(run.id, {
      store: runStore,
      loadDesign: scoped,
      judgeDeps: { store: designStore, judgeFn: failingJudge, loadImage: fakeLoadImage, styleFn: stubStyleAligned, canAudit: false },
    });

    check('outcome "flagged-for-review" even in auto mode', result.outcome === "flagged-for-review", result.outcome);
    check("no Design store writes for an excluded design", designStore.writeCount === 0);
    const finalRun = await runStore.findById(run.id);
    const flagged = JSON.parse(finalRun!.flagged);
    check("excluded design recorded in flagged", flagged.length === 1 && flagged[0].designId === "d1");
  }

  // ── 5. A duplicate/late step (already-completed run) is a safe no-op ────
  console.log("\n=== advanceJudgeRun() — duplicate delivery after completion is a no-op ===");
  {
    const runStore = new FakeJudgeRunStore();
    const run = await runStore.create({
      mode: "manual",
      statusFilter: "unjudged",
      limit: 5,
      status: "completed",
      designIds: JSON.stringify(["d1"]),
      total: 1,
      processed: 1,
      outcomeCounts: "{}",
      verdicts: "[]",
      flagged: "[]",
      error: null,
      startedAt: new Date(),
      completedAt: new Date(),
      createdByEmail: null,
    });
    const result = await advanceJudgeRun(run.id, { store: runStore });
    check("done:true, nothing processed", result.done === true && result.processedDesignId === undefined);
  }

  // ── 6. Mode is frozen — rejectModeChange() always 409s ──────────────────
  console.log("\n=== rejectModeChange() — PATCH's entire contract ===");
  {
    const runningAuto = { mode: "auto" as const };
    const r1 = rejectModeChange(runningAuto);
    check("running auto-mode run -> 409", r1.status === 409);
    check("reports the run's actual (unchanged) mode", r1.mode === "auto");

    const completedManual = { mode: "manual" as const };
    const r2 = rejectModeChange(completedManual);
    check("even a completed run -> still 409 (mode is frozen forever, not just mid-run)", r2.status === 409);
    check("reports the run's actual (unchanged) mode", r2.mode === "manual");
  }

  // ── 7. prepareFlaggedRegeneration() — manual-mode-only precondition checks ─
  console.log("\n=== prepareFlaggedRegeneration() ===");
  {
    const autoRun = { mode: "auto" as const, flagged: "[]" };
    const r = prepareFlaggedRegeneration(autoRun, "d1");
    check('auto-mode run -> 400 ("only available for a manual run")', !r.ok && r.status === 400, JSON.stringify(r));
  }
  {
    const manualRun = { mode: "manual" as const, flagged: JSON.stringify([{ designId: "d2", title: "x", outcome: "would-create-sibling", detail: "", verdict: verdict({}) }]) };
    const r = prepareFlaggedRegeneration(manualRun, "d1");
    check("design not in flagged list -> 404", !r.ok && r.status === 404, JSON.stringify(r));
  }
  {
    const manualRun = {
      mode: "manual" as const,
      flagged: JSON.stringify([{ designId: "d1", title: "x", outcome: "would-create-sibling", detail: "", verdict: verdict({}), siblingId: "sib-1" }]),
    };
    const r = prepareFlaggedRegeneration(manualRun, "d1");
    check("already has a recorded siblingId -> 409", !r.ok && r.status === 409, JSON.stringify(r));
  }
  {
    const v = verdict({ usable: false, colorMatchesArt: false, issues: ["x"] });
    const manualRun = {
      mode: "manual" as const,
      flagged: JSON.stringify([{ designId: "d1", title: "x", outcome: "would-create-sibling", detail: "", verdict: v }]),
    };
    const r = prepareFlaggedRegeneration(manualRun, "d1");
    check("valid manual-mode flagged entry -> ok", r.ok === true, JSON.stringify(r));
    if (r.ok) check("returns the stored verdict for reuse", r.entry.verdict.issues[0] === "x");
  }

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("ERROR", err);
  process.exitCode = 1;
});
