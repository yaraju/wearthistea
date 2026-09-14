/**
 * Unit tests for src/lib/design-judge-bulk.ts (issue #17) — the bulk-only
 * judge extensions sitting alongside design-judge.ts's judgeDesign()
 * (issue #12).
 *
 * Sections, matching the issue's "Validation (automated)" list:
 *  1. existsInGcs() (src/lib/storage.ts) against a mocked GCS client —
 *     object present / object absent / bucket unset -> local-disk-only.
 *     No real GCS credentials needed; the client is fully in-memory.
 *  2. auditDesignIntegrity() against a fixture Design row with a
 *     deliberately missing preview path — pure logic test, existsFn is
 *     stubbed so no GCS call happens.
 *  3. checkStyleAlignment() against a fixture concept that clearly
 *     violates CONCEPT_RULES (a phrase far over the ~32-character target).
 *     Makes a REAL Gemini call (same trade-off as
 *     scripts/test-design-judge.ts's judgeDesign() tests — there's no
 *     offline fallback in the default reviewFn, by design) — needs
 *     GEMINI_API_KEY, costs one real API call.
 *  4. isStuckGenerating() / flagAndTriggerStuckDesign() staleness logic —
 *     pure, no I/O, no API key needed.
 *  5. buildRubricReport()/formatRubricSummary() sanity check.
 *
 * Usage: npx tsx scripts/test-design-judge-bulk.ts
 * Exits non-zero if any assertion fails.
 */
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const { existsInGcs } = await import("../src/lib/storage");
  const {
    auditDesignIntegrity,
    checkStyleAlignment,
    isStuckGenerating,
    flagAndTriggerStuckDesign,
    STUCK_GENERATION_THRESHOLD_MINUTES,
    buildRubricReport,
    formatRubricSummary,
  } = await import("../src/lib/design-judge-bulk");

  let failures = 0;
  function check(label: string, ok: boolean, detail?: string) {
    console.log(`  [${ok ? "ok" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures++;
  }

  // ── 1. existsInGcs() against a mocked GCS client ─────────────────────────
  console.log("=== existsInGcs() — mocked GCS client ===");

  function mockClient(exists: boolean) {
    return {
      bucket: (name: string) => ({
        file: (relPath: string) => ({
          exists: async () => {
            calls.push({ bucket: name, relPath });
            return [exists] as [boolean];
          },
        }),
      }),
    };
  }
  const calls: { bucket: string; relPath: string }[] = [];

  {
    calls.length = 0;
    const present = await existsInGcs("/generated/abc123/front.png", {
      bucket: "test-bucket",
      client: mockClient(true),
    });
    check("object present -> true", present === true);
    check(
      "relPath correctly stripped of /generated/ prefix",
      calls[0]?.relPath === "abc123/front.png",
      JSON.stringify(calls[0])
    );
  }

  {
    calls.length = 0;
    const absent = await existsInGcs("/generated/abc123/front.png", {
      bucket: "test-bucket",
      client: mockClient(false),
    });
    check("object absent -> false", absent === false);
  }

  {
    calls.length = 0;
    // No bucket, no client override -> falls back to the module-level
    // GCS_BUCKET/storage, which are unset in this test process (no
    // GCS_BUCKET passed on the command line) -> local-disk-only -> false,
    // and crucially never attempts a real network call (calls stays empty).
    const bucketUnset = await existsInGcs("/generated/abc123/front.png");
    check("bucket unset -> false (local-disk-only)", bucketUnset === false);
    check("bucket unset -> no client call attempted", calls.length === 0);
  }

  {
    calls.length = 0;
    // Malformed/empty path after stripping the prefix -> false, no call.
    const emptyPath = await existsInGcs("/generated/", { bucket: "test-bucket", client: mockClient(true) });
    check("empty relPath -> false without calling the client", emptyPath === false && calls.length === 0);
  }

  // ── 2. auditDesignIntegrity() against a fixture with a missing path ─────
  console.log("\n=== auditDesignIntegrity() — fixture with a missing preview path ===");

  const completeDesign = {
    designImagePath: "/generated/d1/design.png",
    backDesignImagePath: "/generated/d1/back.png",
    productImagePath: "/generated/d1/product.png",
    designPreviewImagePath: "/generated/d1/design-preview.png",
    productPreviewImagePath: "/generated/d1/product-preview.png",
    backDesignPreviewImagePath: "/generated/d1/back-preview.png",
  };

  {
    const allExist = async () => true;
    const verdict = await auditDesignIntegrity(completeDesign, allExist);
    check("all six paths present + exist -> passed: true", verdict.passed === true, JSON.stringify(verdict.issues));
    check("six checks recorded", verdict.checks.length === 6, String(verdict.checks.length));
    check("no lost objects, no missing fields", verdict.hasLostObjects === false && verdict.hasMissingFields === false);
  }

  {
    // Deliberately missing preview path (per the issue's exact wording).
    const missingPreview = { ...completeDesign, designPreviewImagePath: null };
    const allExist = async () => true;
    const verdict = await auditDesignIntegrity(missingPreview, allExist);
    check("missing preview path -> passed: false", verdict.passed === false);
    check(
      "issues mentions the missing design preview",
      verdict.issues.some((i) => /design preview/i.test(i)),
      JSON.stringify(verdict.issues)
    );
    const previewCheck = verdict.checks.find((c) => c.field === "designPreviewImagePath");
    check("missing field recorded present: false, existsInGcs: null", previewCheck?.present === false && previewCheck?.existsInGcs === null);
    check(
      "a merely-missing field sets hasMissingFields, NOT hasLostObjects (legacy row, not a real loss)",
      verdict.hasMissingFields === true && verdict.hasLostObjects === false
    );
  }

  {
    // Present but not actually in GCS (local-disk-only) -> also a failure,
    // distinct from "missing" — this is the actual incident scenario from
    // project memory (DB path set, file only ever existed on local disk).
    const localDiskOnly = async () => false;
    const verdict = await auditDesignIntegrity(completeDesign, localDiskOnly);
    check("present but not in GCS -> passed: false", verdict.passed === false);
    check(
      "issues describe local-disk-only, not 'missing'",
      verdict.issues.every((i) => /not found in GCS/i.test(i)) && verdict.issues.length === 6,
      JSON.stringify(verdict.issues)
    );
    check(
      "a present-but-absent field sets hasLostObjects, NOT hasMissingFields — a genuine loss",
      verdict.hasLostObjects === true && verdict.hasMissingFields === false
    );
  }

  {
    // The GCS_BUCKET gotcha, at the audit level: calling with the REAL
    // default existsFn while storage isn't configured (this test process
    // has no GCS_BUCKET set) must throw rather than silently reporting
    // every path as "lost" — that false-fail-avalanche is exactly what a
    // bulk runner (#18) must never write to production rows.
    let threw = false;
    try {
      await auditDesignIntegrity(completeDesign); // no existsFn override -> uses the real default
    } catch {
      threw = true;
    }
    check("default existsFn + unconfigured GCS_BUCKET -> throws instead of reporting false failures", threw === true);
  }

  // ── 3. checkStyleAlignment() against a CONCEPT_RULES violation ──────────
  console.log("\n=== checkStyleAlignment() — fixture violating CONCEPT_RULES (real Gemini call) ===");
  if (!process.env.GEMINI_API_KEY) {
    console.log("  [skip] GEMINI_API_KEY not set — skipping real-API style-alignment checks.");
  } else {
    const violatingPhrase =
      "This Phrase Is Deliberately Way Too Long To Ever Fit On A Chest Print And Blows Past The Character Limit By A Wide Margin";
    const violating = {
      phrase: violatingPhrase,
      visualConcept: "A plain circle icon behind the phrase, nothing else in the composition.",
      backPhrase: "the back just says the exact same thing as the front phrase",
    };
    const verdict = await checkStyleAlignment(violating);
    console.log("  verdict:", JSON.stringify(verdict));
    check("over-length phrase -> aligned: false", verdict.aligned === false);
    check("violations is non-empty", verdict.violations.length > 0, JSON.stringify(verdict.violations));

    const clean = {
      phrase: "GROUP CHAT SURVIVOR",
      visualConcept:
        "A badge-style emblem with a cracked phone screen at the center, cartoon sweat drops flying off the corners, bold streetwear line-art style.",
      backPhrase: "block, mute, repeat",
    };
    const cleanVerdict = await checkStyleAlignment(clean);
    console.log("  verdict:", JSON.stringify(cleanVerdict));
    check("clean concept -> aligned: true", cleanVerdict.aligned === true, JSON.stringify(cleanVerdict.violations));
  }

  // Stub-based DI check regardless of API key — proves reviewFn injection works.
  {
    const stubVerdict = await checkStyleAlignment(
      { phrase: "X".repeat(200), visualConcept: "v", backPhrase: null },
      async () => ({ aligned: false, violations: ["phrase way too long"] })
    );
    check("injected reviewFn stub is used instead of the real Gemini call", stubVerdict.aligned === false && stubVerdict.violations[0] === "phrase way too long");
  }

  // ── 4. Stuck-generation staleness logic ──────────────────────────────────
  console.log("\n=== isStuckGenerating() / flagAndTriggerStuckDesign() — staleness threshold ===");

  const now = new Date("2026-09-15T12:00:00Z");

  {
    const old = { id: "d1", status: "generating", updatedAt: new Date("2026-09-15T11:00:00Z") }; // 60m old
    check(
      `old "generating" design (60m > ${STUCK_GENERATION_THRESHOLD_MINUTES}m threshold) -> flagged stuck`,
      isStuckGenerating(old, now) === true
    );
  }

  {
    const fresh = { id: "d2", status: "generating", updatedAt: new Date("2026-09-15T11:55:00Z") }; // 5m old
    check("fresh \"generating\" design (5m old) -> not stuck", isStuckGenerating(fresh, now) === false);
  }

  {
    const oldButDone = { id: "d3", status: "generated", updatedAt: new Date("2026-09-15T09:00:00Z") };
    check("old but status=generated -> never flagged stuck", isStuckGenerating(oldButDone, now) === false);
  }

  {
    // Custom threshold override.
    const design = { id: "d4", status: "generating", updatedAt: new Date("2026-09-15T11:50:00Z") }; // 10m old
    check("10m old, 5m threshold -> stuck", isStuckGenerating(design, now, 5) === true);
    check("10m old, 15m threshold -> not stuck", isStuckGenerating(design, now, 15) === false);
  }

  {
    // flagAndTriggerStuckDesign in its default dryRun mode must never touch
    // the DB / never call Gemini — just report the flag. Cast is safe: only
    // the fields isStuckGenerating/the age calc read are exercised before
    // the (untaken) dryRun-false branch would need the rest of a real Design.
    const stuckDesign = { id: "d5", status: "generating", updatedAt: new Date("2026-09-15T11:00:00Z") } as unknown as Parameters<
      typeof flagAndTriggerStuckDesign
    >[0];
    const result = await flagAndTriggerStuckDesign(stuckDesign, { now });
    check('default dryRun -> action: "flagged", no DB/API touched', result.action === "flagged", JSON.stringify(result));
    check("ageMinutes computed correctly (~60)", result.ageMinutes === 60, String(result.ageMinutes));

    const notStuckDesign = { id: "d6", status: "generating", updatedAt: new Date("2026-09-15T11:55:00Z") } as unknown as Parameters<
      typeof flagAndTriggerStuckDesign
    >[0];
    const notStuckResult = await flagAndTriggerStuckDesign(notStuckDesign, { now });
    check('fresh design -> action: "not-stuck", never treated as flaggable', notStuckResult.action === "not-stuck");
  }

  // ── 5. Rubric reporting ───────────────────────────────────────────────────
  console.log("\n=== buildRubricReport() / formatRubricSummary() ===");

  const verdicts = [
    { designId: "a", judge: { colorMatchesArt: true, usable: true }, integrity: { passed: true }, style: { aligned: true }, stuck: false },
    { designId: "b", judge: { colorMatchesArt: false, usable: true }, integrity: { passed: true }, style: { aligned: false }, stuck: false },
    { designId: "c", judge: { colorMatchesArt: true, usable: false }, integrity: { passed: false }, style: { aligned: true }, stuck: true },
  ];
  const report = buildRubricReport(verdicts);
  const byName = Object.fromEntries(report.map((r) => [r.name, r]));

  check("color-fitness: 2/3", byName["color-fitness"]?.passed === 2 && byName["color-fitness"]?.total === 3);
  check("garment-in-graphic: 2/3", byName["garment-in-graphic"]?.passed === 2 && byName["garment-in-graphic"]?.total === 3);
  check("integrity: 2/3", byName["integrity"]?.passed === 2 && byName["integrity"]?.total === 3);
  check("style-alignment: 2/3", byName["style-alignment"]?.passed === 2 && byName["style-alignment"]?.total === 3);
  check("stuck-generation: 2/3 healthy (1 flagged stuck)", byName["stuck-generation"]?.passed === 2 && byName["stuck-generation"]?.total === 3);

  const summary = formatRubricSummary(report);
  console.log(summary);
  check("summary mentions all five rubric names", ["color-fitness", "garment-in-graphic", "integrity", "style-alignment", "stuck-generation"].every((n) => summary.includes(n)));

  const emptyReport = buildRubricReport([]);
  const emptySummary = formatRubricSummary(emptyReport);
  check('empty input -> "no designs checked" rather than misleading 0/0 (0%)', emptySummary.includes("no designs checked"));

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("ERROR", err);
  process.exitCode = 1;
});
