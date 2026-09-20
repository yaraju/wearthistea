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
 * Issue #33 (rows stranded at "regenerating") adds issue33Cases(): a
 * non-programmatic verdict never reaches the fix queue, a failing/exhausted
 * fix or regenerate ends the row terminally, a failed enqueue rolls back and
 * stays resumable, sibling creation atomically supersedes the original
 * (late/duplicate tasks are no-ops), and the stuck-row sweeper.
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

  async createSiblingAndSupersede(sourceId: string, data: Prisma.DesignUncheckedCreateInput) {
    const src = this.rows.get(sourceId);
    if (!src || src.validationStatus !== "regenerating") return null;
    src.validationStatus = "superseded";
    return this.create(data);
  }

  async findStuck(cutoff: Date, limit: number) {
    return [...this.rows.values()]
      .filter((r) => ["pending", "validating", "regenerating"].includes(r.validationStatus) && r.updatedAt < cutoff)
      .slice(0, limit)
      .map((r) => ({ ...r }));
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

async function issue33Cases() {
  const {
    runJudgeStep,
    runJudgeAndRoute,
    runFixStep,
    runRegenerateStep,
    abandonFixStep,
    abandonJudgeStep,
    abandonRegenerateStep,
  } = await import("../src/lib/validation-chain");
  const { sweepStuckValidations, SWEEPER_RETRY_MARKER } = await import("../src/lib/validation-sweeper");
  const { isFinalDelivery } = await import("../src/lib/task-retry");

  const regenVerdict = verdict({ usable: false, colorMatchesArt: false, fix: "regenerate" });
  const relabelVerdict = verdict({ usable: false, colorMatchesArt: false, fix: "relabel" });
  const noopEnqueue = async () => true;

  console.log("\n=== #33 (a1): verdict.fix=regenerate with the regen budget spent is REJECTED, never sent to the fix queue ===");
  {
    // The prod stranding: sibling rows carry regen=1, judge said "regenerate",
    // the old fallback routed to fix-design, which can only throw.
    const store = new FakeDesignStore();
    store.seed("s1", { validationStatus: "pending", validationFixAttempts: 1, validationRegenAttempts: 1 });
    const judge = scriptedJudge([regenVerdict]);
    const action = await runJudgeStep("s1", { store, judgeFn: judge.fn, loadImage: fakeLoadImage });
    check('routes to "rejected"', action.type === "rejected", JSON.stringify(action));
    check('row is terminal "rejected"', store.rows.get("s1")?.validationStatus === "rejected");
  }

  console.log("\n=== #33 (a2): fix step given a non-programmatic verdict ends the row and does not throw/retry ===");
  {
    const store = new FakeDesignStore();
    store.seed("s2", { validationStatus: "regenerating" });
    const res = await runFixStep("s2", regenVerdict, {
      store,
      applyFix: async () => {
        throw new Error("would never be reached");
      },
    });
    check("ok+skipped (no 5xx retry loop)", res.ok === true && res.skipped === true, JSON.stringify(res));
    check('row terminal "rejected"', store.rows.get("s2")?.validationStatus === "rejected");
  }

  console.log("\n=== #33 (a3): a throwing fix stays retryable and resumable; final-attempt abandon ends it terminally ===");
  {
    const store = new FakeDesignStore();
    store.seed("s3", { validationStatus: "regenerating", validationFixAttempts: 1 });
    const failing = async () => {
      throw new Error("sharp OOM");
    };
    const r1 = await runFixStep("s3", relabelVerdict, { store, applyFix: failing });
    check("throwing fix -> ok:false (route answers 5xx)", r1.ok === false && r1.error === "sharp OOM");
    check('row still "regenerating" and retryable', store.rows.get("s3")?.validationStatus === "regenerating");
    const r2 = await runFixStep("s3", relabelVerdict, { store, applyFix: fakeApplyFix });
    check("a redelivered fix resumes the mid-flight row (not a no-op)", r2.ok === true && !r2.skipped);
    check('successful fix hands the row back to "pending" (judge-claimable)', store.rows.get("s3")?.validationStatus === "pending");
    store.seed("s3b", { validationStatus: "regenerating" });
    await abandonFixStep("s3b", "sharp OOM", store);
    check(
      'final-attempt abandon -> terminal "rejected" with a reason',
      store.rows.get("s3b")?.validationStatus === "rejected" && /sharp OOM/.test(store.rows.get("s3b")?.validationNotes ?? "")
    );
    const lateAbandon = await abandonFixStep("s3", "late", store);
    check("abandon never clobbers a row another task already moved on", lateAbandon === false && store.rows.get("s3")?.validationStatus === "pending");
  }

  console.log("\n=== #33 (a4): duplicate/late fix task is a no-op; judge on a fix/regenerate-owned row is a no-op ===");
  {
    const store = new FakeDesignStore();
    store.seed("s4", { validationStatus: "regenerating" });
    let applied = 0;
    const applyFix = async () => {
      applied++;
    };
    await runFixStep("s4", relabelVerdict, { store, applyFix });
    const replay = await runFixStep("s4", relabelVerdict, { store, applyFix });
    check("replayed fix skipped, applyFix ran once", replay.skipped === true && applied === 1, `applied=${applied}`);
    store.seed("s4b", { validationStatus: "regenerating" });
    const judge = scriptedJudge([verdict({})]);
    const j = await runJudgeStep("s4b", { store, judgeFn: judge.fn, loadImage: fakeLoadImage });
    check('duplicate judge task on a "regenerating" row is a no-op', j.type === "skipped" && judge.callCount() === 0, JSON.stringify(j));
  }

  console.log("\n=== #33 (a5): judge->fix enqueue failure rolls the row back so the retry re-routes (no double count, no strand) ===");
  {
    const store = new FakeDesignStore();
    store.seed("s5", { validationStatus: "pending" });
    const judge = scriptedJudge([relabelVerdict, relabelVerdict]);
    let fixEnqueues = 0;
    let failOnce = true;
    const deps = {
      store,
      judgeFn: judge.fn,
      loadImage: fakeLoadImage,
      enqueueFix: async () => {
        if (failOnce) {
          failOnce = false;
          throw new Error("cloud tasks 503");
        }
        fixEnqueues++;
        return true;
      },
      enqueueRegenerate: noopEnqueue,
    };
    let threw = false;
    try {
      await runJudgeAndRoute("s5", deps);
    } catch {
      threw = true;
    }
    const mid = store.rows.get("s5");
    check("enqueue failure surfaces (route answers 5xx)", threw);
    check(
      'row rolled back to "validating" with the attempt un-consumed',
      mid?.validationStatus === "validating" && mid.validationFixAttempts === 0,
      JSON.stringify(mid && { s: mid.validationStatus, f: mid.validationFixAttempts })
    );
    const again = await runJudgeAndRoute("s5", deps);
    const end = store.rows.get("s5");
    check("retry re-routes to fix", again.type === "enqueue-fix" && fixEnqueues === 1);
    check('retry leaves "regenerating" with exactly 1 attempt', end?.validationStatus === "regenerating" && end.validationFixAttempts === 1);

    store.seed("s5b", { validationStatus: "validating" });
    await abandonJudgeStep("s5b", "gemini 500", store);
    check('judge final-attempt abandon -> terminal "unjudged"', store.rows.get("s5b")?.validationStatus === "unjudged");

    store.seed("s5c", { validationStatus: "pending" });
    const j2 = scriptedJudge([regenVerdict]);
    const noQ = await runJudgeAndRoute("s5c", { ...deps, judgeFn: j2.fn, enqueueRegenerate: async () => false });
    check('unconfigured queue -> row ends "unjudged", not stranded', noQ.type === "skipped" && store.rows.get("s5c")?.validationStatus === "unjudged", JSON.stringify(noQ));
  }

  console.log("\n=== #33 (a6): regenerate render throws -> retry resumes the same sibling; final abandon ends the lineage ===");
  {
    const store = new FakeDesignStore();
    store.seed("r1", { validationStatus: "regenerating" });
    let calls = 0;
    const flaky = async (sib: Design): Promise<Design> => {
      calls++;
      if (calls === 1) throw new Error("gemini 429 / rate limit");
      return store.update(sib.id, { status: "generated" });
    };
    const first = await runRegenerateStep("r1", regenVerdict, { store, renderFn: flaky });
    check("first attempt fails (route answers 5xx)", first.ok === false && Boolean(first.siblingId));
    const retry = await runRegenerateStep("r1", regenVerdict, { store, renderFn: flaky });
    check("retry resumes the SAME sibling and finishes", retry.ok === true && retry.siblingId === first.siblingId && Boolean(retry.judgeTargetId));
    check("still exactly one sibling row", store.rows.size === 2);

    store.seed("r2", { validationStatus: "regenerating" });
    const bad = await runRegenerateStep("r2", regenVerdict, {
      store,
      renderFn: async () => {
        throw new Error("permanent");
      },
    });
    await abandonRegenerateStep("r2", "permanent", store);
    const sib = store.rows.get(bad.siblingId!);
    check('final abandon: sibling ends "rejected" + status "failed"', sib?.validationStatus === "rejected" && sib.status === "failed");
    check('source stays "superseded" (terminal)', store.rows.get("r2")?.validationStatus === "superseded");
  }

  console.log("\n=== #33 (b): sibling creation atomically supersedes the original; late/duplicate tasks are no-ops ===");
  {
    const store = new FakeDesignStore();
    store.seed("o1", { validationStatus: "regenerating" });
    const made = await runRegenerateStep("o1", regenVerdict, { store, renderFn: async (s) => s });
    check("sibling created", made.ok === true && Boolean(made.siblingId));
    check('original flipped to "superseded"', store.rows.get("o1")?.validationStatus === "superseded");

    const rows = store.rows.size;
    const judge = scriptedJudge([verdict({})]);
    const lateJudge = await runJudgeStep("o1", { store, judgeFn: judge.fn, loadImage: fakeLoadImage });
    check("late judge task for the original is skipped, judge not called", lateJudge.type === "skipped" && judge.callCount() === 0);
    let fixCalls = 0;
    const lateFix = await runFixStep("o1", relabelVerdict, { store, applyFix: async () => void fixCalls++ });
    check("late fix task for the original is skipped", lateFix.skipped === true && fixCalls === 0);
    check('original still "superseded" after the late tasks', store.rows.get("o1")?.validationStatus === "superseded");

    store.seed("o2", { validationStatus: "superseded" });
    const dup = await runRegenerateStep("o2", regenVerdict, { store, renderFn: async (s) => s });
    check("duplicate regenerate for a non-regenerating original creates nothing", dup.skipped === true && store.rows.size === rows + 1);

    store.seed("o3", { validationStatus: "regenerating" });
    const [c1, c2] = await Promise.all([
      runRegenerateStep("o3", regenVerdict, { store, renderFn: async (s) => s }),
      runRegenerateStep("o3", regenVerdict, { store, renderFn: async (s) => s }),
    ]);
    const sibs = [...store.rows.values()].filter((r) => r.regeneratedFromDesignId === "o3");
    check("concurrent duplicate regenerates yield exactly one sibling", sibs.length === 1 && [c1, c2].some((c) => c.skipped), `siblings=${sibs.length}`);
  }

  console.log("\n=== #33 (c): stuck-row sweeper ===");
  {
    const store = new FakeDesignStore();
    const now = new Date("2026-09-20T12:00:00Z");
    const old = new Date(now.getTime() - 45 * 60_000);
    const fresh = new Date(now.getTime() - 5 * 60_000);
    store.seed("w-old-regen", { validationStatus: "regenerating", updatedAt: old });
    store.seed("w-old-pending", { validationStatus: "pending", updatedAt: old });
    store.seed("w-old-validating", { validationStatus: "validating", updatedAt: old });
    store.seed("w-fresh", { validationStatus: "regenerating", updatedAt: fresh });
    store.seed("w-done", { validationStatus: "validated", updatedAt: old });
    store.seed("w-noart", { validationStatus: "pending", status: "generating", updatedAt: old });
    store.seed("w-retried", {
      validationStatus: "regenerating",
      updatedAt: old,
      validationNotes: `${SWEEPER_RETRY_MARKER} re-judging`,
    });
    const enqueued: string[] = [];
    const res = await sweepStuckValidations({
      store,
      now,
      enqueueJudge: async (id) => {
        enqueued.push(id);
        return true;
      },
    });
    const st = (id: string) => store.rows.get(id)?.validationStatus;
    check(
      "stale in-flight rows retried once: re-queued at pending + judge enqueued",
      ["w-old-regen", "w-old-pending", "w-old-validating"].every((id) => st(id) === "pending" && enqueued.includes(id)),
      JSON.stringify(res)
    );
    check("retry marker stamped into validationNotes", (store.rows.get("w-old-regen")?.validationNotes ?? "").startsWith(SWEEPER_RETRY_MARKER));
    check("fresh in-flight row left alone", st("w-fresh") === "regenerating" && !enqueued.includes("w-fresh"));
    check("terminal row left alone", st("w-done") === "validated");
    check('never-rendered row -> "rejected" with reason', st("w-noart") === "rejected" && /never rendered/.test(store.rows.get("w-noart")?.validationNotes ?? ""));
    check('row already retried once -> "rejected" with reason', st("w-retried") === "rejected" && /after one sweeper retry/.test(store.rows.get("w-retried")?.validationNotes ?? ""));

    // The retry itself stalled: the marker (kept until the judge rewrites notes) makes the next sweep terminal.
    const later = new Date(now.getTime() + 60 * 60_000);
    await sweepStuckValidations({ store, now: later, enqueueJudge: noopEnqueue });
    check('a retried row that stalls again ends "rejected"', st("w-old-regen") === "rejected");

    const store2 = new FakeDesignStore();
    store2.seed("w-noq", { validationStatus: "regenerating", updatedAt: old });
    await sweepStuckValidations({ store: store2, now, enqueueJudge: async () => false });
    check('un-enqueueable judge -> "rejected"', store2.rows.get("w-noq")?.validationStatus === "rejected");
  }

  console.log("\n=== #33: final-delivery detection ===");
  {
    const mk = (n?: string) => new Request("http://x", { headers: n == null ? {} : { "x-cloudtasks-taskretrycount": n } });
    check("no header -> not final", isFinalDelivery(mk(), 4) === false);
    check("retry count 2 of 4 -> not final", isFinalDelivery(mk("2"), 4) === false);
    check("retry count 3 of 4 -> final", isFinalDelivery(mk("3"), 4) === true);
  }
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

  await issue33Cases();

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("ERROR", err);
  process.exitCode = 1;
});
