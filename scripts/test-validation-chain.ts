/**
 * Automated validation for issue #13 — the judge -> fix/regenerate -> judge
 * chain wired in src/lib/validation-chain.ts.
 *
 * Deliberately does NOT touch the real (shared prod) Neon DB or spend a
 * real Gemini call: it drives runJudgeStep/runFixStep/runRegenerateStep
 * against an in-memory fake DesignStore, with a scripted fake judge
 * function and a fake render function injected via each function's `deps`
 * parameter — the exact seam validation-chain.ts's top doc comment
 * describes. This is what makes it possible to assert the FULL state
 * machine (attempt caps, routing, idempotency) deterministically and
 * cheaply, matching every other pure-logic script in this directory (e.g.
 * test-poll-stop-condition.ts).
 *
 * Covers this issue's three automated-validation criteria verbatim:
 *   1. A design seeded to fail the judge once ends at "validated" after
 *      exactly one fix cycle, with validationFixAttempts incremented
 *      correctly.
 *   2. A design seeded to fail every attempt ends at "rejected" after
 *      exactly the capped number of cycles (2 programmatic + 1 regen),
 *      never looping further.
 *   3. Replaying the same task payload twice (simulating a Cloud Tasks
 *      retry) does not double-count attempts or re-run a judge pass on an
 *      already-terminal design.
 *
 * Usage: npx tsx scripts/test-validation-chain.ts
 * Exits non-zero if any assertion fails.
 */
import type { Design, Prisma } from "@prisma/client";
import type { JudgeVerdict } from "../src/lib/design-judge";
import type { DesignStore } from "../src/lib/validation-chain";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  [${ok ? "ok" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ── In-memory fake DesignStore ──────────────────────────────────────────
class FakeDesignStore implements DesignStore {
  rows = new Map<string, Design>();
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
    const row = this.rows.get(id);
    if (!row || !expectedStatuses.includes(row.validationStatus)) return null;
    Object.assign(row, data);
    return { ...row };
  }

  async update(id: string, data: Prisma.DesignUncheckedUpdateInput) {
    const row = this.rows.get(id);
    if (!row) throw new Error(`FakeDesignStore.update: no row ${id}`);
    Object.assign(row, data);
    return { ...row };
  }

  async create(data: Prisma.DesignUncheckedCreateInput) {
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
    designImageData: "ZmFrZQ==", // "fake" — used as the loadImage stub's source
    designSVGData: null,
    status: "generated",
    errorMessage: null,
    validationStatus: "pending",
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

// ── Fake judge: a fixed, scripted sequence of verdicts ───────────────────
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

function scriptedJudge(sequence: JudgeVerdict[]) {
  let calls = 0;
  const fn = async (): Promise<JudgeVerdict> => {
    if (calls >= sequence.length) {
      throw new Error(`scriptedJudge: exhausted after ${calls} calls — test wired for too few verdicts`);
    }
    return sequence[calls++];
  };
  return { fn, callCount: () => calls };
}

async function fakeLoadImage(): Promise<string> {
  return "ZmFrZQ==";
}

async function fakeApplyFix(): Promise<void> {
  // no-op — this test exercises the state machine only, not #14's real
  // fix implementations (see scripts/test-design-fixes.ts for those).
}

function fakeRenderFn(design: Design): Promise<Design> {
  return Promise.resolve({ ...design, status: "generated" });
}

async function main() {
  const { runJudgeStep, runFixStep, runRegenerateStep, FIX_ATTEMPT_CAP, REGEN_ATTEMPT_CAP } = await import(
    "../src/lib/validation-chain"
  );

  check("FIX_ATTEMPT_CAP is 2 (issue #13's spec)", FIX_ATTEMPT_CAP === 2, `got ${FIX_ATTEMPT_CAP}`);
  check("REGEN_ATTEMPT_CAP is 1 (issue #13's spec)", REGEN_ATTEMPT_CAP === 1, `got ${REGEN_ATTEMPT_CAP}`);

  // ── Criterion 1: fails once, then passes -> validated after one fix cycle
  console.log("\n=== Criterion 1: fails judge once, then passes -> validated after exactly 1 fix cycle ===");
  {
    const store = new FakeDesignStore();
    store.seed("d1", { validationStatus: "pending" });
    const judge = scriptedJudge([
      verdict({ usable: false, colorMatchesArt: false, fix: "relabel", issues: ["ink mismatch"] }),
      verdict({ usable: true, colorMatchesArt: true, fix: "none" }),
    ]);

    const action1 = await runJudgeStep("d1", { store, judgeFn: judge.fn, loadImage: fakeLoadImage });
    check('first judge pass routes to "enqueue-fix"', action1.type === "enqueue-fix", JSON.stringify(action1));
    const afterJudge1 = await store.findById("d1");
    check("validationFixAttempts incremented to 1", afterJudge1?.validationFixAttempts === 1);
    check("validationRegenAttempts still 0", afterJudge1?.validationRegenAttempts === 0);
    check('validationStatus is "regenerating" (in-flight, badge fires)', afterJudge1?.validationStatus === "regenerating");

    if (action1.type === "enqueue-fix") {
      const fixResult = await runFixStep("d1", action1.verdict, { store, applyFix: fakeApplyFix });
      check("fix step succeeds, not skipped", fixResult.ok === true && !fixResult.skipped, JSON.stringify(fixResult));
    }

    const action2 = await runJudgeStep("d1", { store, judgeFn: judge.fn, loadImage: fakeLoadImage });
    check('second judge pass -> "validated"', action2.type === "validated", JSON.stringify(action2));
    const final = await store.findById("d1");
    check('final validationStatus is "validated"', final?.validationStatus === "validated");
    check("validationFixAttempts stayed at 1 (no double-increment)", final?.validationFixAttempts === 1);
    check("judge was called exactly twice", judge.callCount() === 2, `got ${judge.callCount()}`);
  }

  // ── Criterion 2: fails every attempt -> rejected after exactly 2 fix + 1 regen
  console.log("\n=== Criterion 2: fails every attempt -> rejected after exactly 2 fix + 1 regen cycles ===");
  {
    const store = new FakeDesignStore();
    store.seed("d2", { validationStatus: "pending", variantColor: "White" });
    const judge = scriptedJudge([
      verdict({ usable: false, colorMatchesArt: false, fix: "relabel", issues: ["fail 1"] }),
      verdict({ usable: false, colorMatchesArt: false, fix: "relabel", issues: ["fail 2"] }),
      verdict({ usable: false, colorMatchesArt: false, fix: "regenerate", issues: ["fail 3 — needs full regen"] }),
      verdict({ usable: false, colorMatchesArt: false, fix: "relabel", issues: ["fail 4 — still broken"] }),
    ]);

    let fixCalls = 0;
    let regenCalls = 0;
    let judgeTargetId = "d2";

    let lastAction = await runJudgeStep(judgeTargetId, { store, judgeFn: judge.fn, loadImage: fakeLoadImage });
    let cycles = 0;
    const MAX_CYCLES = 10; // safety net so a bug here can't spin the test forever
    while (lastAction.type === "enqueue-fix" || lastAction.type === "enqueue-regenerate") {
      cycles++;
      if (cycles > MAX_CYCLES) throw new Error("Test loop exceeded MAX_CYCLES — chain isn't terminating");

      if (lastAction.type === "enqueue-fix") {
        fixCalls++;
        const fixResult = await runFixStep(judgeTargetId, lastAction.verdict, { store, applyFix: fakeApplyFix });
        check(`fix cycle ${fixCalls} succeeds`, fixResult.ok === true && !fixResult.skipped);
      } else {
        regenCalls++;
        const regenResult = await runRegenerateStep(judgeTargetId, lastAction.verdict, {
          store,
          renderFn: fakeRenderFn,
        });
        check(`regen cycle ${regenCalls} succeeds and produces a sibling`, regenResult.ok === true && Boolean(regenResult.siblingId));
        if (regenResult.judgeTargetId) judgeTargetId = regenResult.judgeTargetId;
      }

      lastAction = await runJudgeStep(judgeTargetId, { store, judgeFn: judge.fn, loadImage: fakeLoadImage });
    }

    check('chain ends at "rejected"', lastAction.type === "rejected", JSON.stringify(lastAction));
    check("exactly 2 fix cycles ran", fixCalls === 2, `got ${fixCalls}`);
    check("exactly 1 regen cycle ran", regenCalls === 1, `got ${regenCalls}`);
    check("judge was called exactly 4 times", judge.callCount() === 4, `got ${judge.callCount()}`);

    const source = await store.findById("d2");
    check('source design ends "superseded" (not mutated further after regen)', source?.validationStatus === "superseded");

    const terminalDesign = await store.findById(judgeTargetId);
    check("terminal (sibling) design carried the cumulative fix budget (2)", terminalDesign?.validationFixAttempts === 2, `got ${terminalDesign?.validationFixAttempts}`);
    check("terminal (sibling) design carried the cumulative regen budget (1)", terminalDesign?.validationRegenAttempts === 1, `got ${terminalDesign?.validationRegenAttempts}`);
    check('terminal (sibling) design ends "rejected"', terminalDesign?.validationStatus === "rejected");
    check("sibling is a different row than the source", judgeTargetId !== "d2");

    // "never loop further" — a subsequent judge dispatch against the
    // terminal design must skip, not re-judge.
    const afterTerminal = await runJudgeStep(judgeTargetId, { store, judgeFn: judge.fn, loadImage: fakeLoadImage });
    check("a judge call after rejection is skipped, not re-run", afterTerminal.type === "skipped", JSON.stringify(afterTerminal));
    check("judge call count unchanged by the post-rejection call", judge.callCount() === 4, `got ${judge.callCount()}`);
  }

  // ── Criterion 3: replay (simulated Cloud Tasks retry) doesn't double-count
  console.log("\n=== Criterion 3: replaying the same task payload twice doesn't double-count or re-judge ===");
  {
    // 3a. Replaying judge-design after the design already reached a
    // terminal state (validated) must no-op.
    const store = new FakeDesignStore();
    store.seed("d3", { validationStatus: "pending" });
    const judge = scriptedJudge([verdict({ usable: true, colorMatchesArt: true, fix: "none" })]);

    const first = await runJudgeStep("d3", { store, judgeFn: judge.fn, loadImage: fakeLoadImage });
    check('first dispatch -> "validated"', first.type === "validated");

    const replay = await runJudgeStep("d3", { store, judgeFn: judge.fn, loadImage: fakeLoadImage });
    check("replayed judge-design dispatch is skipped", replay.type === "skipped", JSON.stringify(replay));
    check("judge was NOT called a second time by the replay", judge.callCount() === 1, `got ${judge.callCount()}`);
    const afterReplay = await store.findById("d3");
    check('validationStatus still "validated" after replay', afterReplay?.validationStatus === "validated");

    // 3b. Replaying fix-design after the design already moved past
    // "regenerating" must no-op.
    const store2 = new FakeDesignStore();
    store2.seed("d4", { validationStatus: "pending" });
    const judge2 = scriptedJudge([
      verdict({ usable: false, colorMatchesArt: false, fix: "relabel" }),
      verdict({ usable: true, colorMatchesArt: true, fix: "none" }),
    ]);
    const a1 = await runJudgeStep("d4", { store: store2, judgeFn: judge2.fn, loadImage: fakeLoadImage });
    if (a1.type === "enqueue-fix") {
      await runFixStep("d4", a1.verdict, { store: store2, applyFix: fakeApplyFix });
    }
    await runJudgeStep("d4", { store: store2, judgeFn: judge2.fn, loadImage: fakeLoadImage }); // -> validated
    let fixReplayCalls = 0;
    const countingApplyFix = async () => {
      fixReplayCalls++;
    };
    const fixReplay = await runFixStep("d4", verdict({ fix: "relabel" }), { store: store2, applyFix: countingApplyFix });
    check("replayed fix-design dispatch is skipped (design past \"regenerating\")", fixReplay.skipped === true, JSON.stringify(fixReplay));
    check("applyFix was NOT invoked by the replay", fixReplayCalls === 0);
    const d4Final = await store2.findById("d4");
    check('validationFixAttempts unchanged by the replay (still 1)', d4Final?.validationFixAttempts === 1);

    // 3c. Replaying regenerate-design after a sibling already exists must
    // reuse it, not create a second one or double-count anything.
    const store3 = new FakeDesignStore();
    store3.seed("d5", {
      validationStatus: "regenerating",
      validationFixAttempts: 2,
      validationRegenAttempts: 0,
    });
    const v = verdict({ usable: false, colorMatchesArt: false, fix: "regenerate" });
    const firstRegen = await runRegenerateStep("d5", v, { store: store3, renderFn: fakeRenderFn });
    check("first regenerate-design dispatch creates a sibling", firstRegen.ok === true && Boolean(firstRegen.siblingId));

    // Simulate a Cloud Tasks retry of the SAME dispatch — the source is
    // still (or again) "regenerating" is not required; runRegenerateStep's
    // own precondition is checked against current state, so force it back
    // to simulate "the response to the first attempt was lost, Cloud Tasks
    // redelivers" — regardless, findByRegeneratedFrom must short-circuit
    // sibling creation.
    const siblingsCreatedBeforeReplay = store3.rows.size;
    const replayRegen = await runRegenerateStep("d5", v, { store: store3, renderFn: fakeRenderFn });
    check(
      "replayed regenerate-design dispatch reuses the existing sibling",
      replayRegen.siblingId === firstRegen.siblingId,
      `first=${firstRegen.siblingId} replay=${replayRegen.siblingId}`
    );
    check("no extra sibling row was created by the replay", store3.rows.size === siblingsCreatedBeforeReplay, `rows=${store3.rows.size}`);
  }

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("ERROR", err);
  process.exitCode = 1;
});
