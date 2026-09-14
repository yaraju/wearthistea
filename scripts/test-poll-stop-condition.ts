/**
 * Unit test for the poll-stop-condition logic added by issue #16 (frontend
 * validation badge over an already-visible design image).
 *
 * Pure logic test — no DB, no network, no React. Exercises
 * shouldStopPolling()/isValidationInFlight() (src/lib/validation-status.ts),
 * the predicate shared by KeywordStudio.tsx's pollBatchStatus() and its
 * mount-restore effect, both of which must keep polling (and keep the badge
 * up) through validationStatus pending/validating/regenerating even once
 * every design's `status` is already "generated".
 *
 * Usage: npx tsx scripts/test-poll-stop-condition.ts
 * Exits non-zero if any assertion fails.
 */

async function main() {
  const { shouldStopPolling, isValidationInFlight, VALIDATION_STATUSES } = await import(
    "../src/lib/validation-status"
  );

  let failures = 0;
  function assertEqual(label: string, actual: unknown, expected: unknown) {
    const ok = actual === expected;
    console.log(`  [${ok ? "ok" : "FAIL"}] ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    if (!ok) failures++;
  }

  console.log("=== Issue #16 acceptance criteria, verbatim ===");

  // "a batch with one design still validationStatus: 'validating' does not
  // stop polling even though status: 'generated'"
  assertEqual(
    "one design generated+validating among otherwise-done designs -> does NOT stop",
    shouldStopPolling([
      { status: "generated", validationStatus: "validated" },
      { status: "generated", validationStatus: "validating" },
      { status: "generated", validationStatus: "rejected" },
    ]),
    false
  );

  // "a batch where every design is validated|rejected|unjudged does stop"
  assertEqual(
    "every design validated|rejected|unjudged, all status generated -> DOES stop",
    shouldStopPolling([
      { status: "generated", validationStatus: "validated" },
      { status: "generated", validationStatus: "rejected" },
      { status: "generated", validationStatus: "unjudged" },
    ]),
    true
  );

  console.log("\n=== Each in-flight validationStatus individually blocks stopping ===");
  for (const s of ["pending", "validating", "regenerating"]) {
    assertEqual(
      `single design status generated + validationStatus "${s}" -> does NOT stop`,
      shouldStopPolling([{ status: "generated", validationStatus: s }]),
      false
    );
  }

  console.log("\n=== Each terminal validationStatus individually allows stopping ===");
  for (const s of ["validated", "rejected", "unjudged", "superseded"]) {
    assertEqual(
      `single design status generated + validationStatus "${s}" -> DOES stop`,
      shouldStopPolling([{ status: "generated", validationStatus: s }]),
      true
    );
  }

  console.log("\n=== status: 'generating' still blocks stopping regardless of validationStatus ===");
  assertEqual(
    "status generating + validationStatus validated -> does NOT stop (art still rendering)",
    shouldStopPolling([{ status: "generating", validationStatus: "validated" }]),
    false
  );

  console.log("\n=== Missing/unknown validationStatus (e.g. a pre-#11 payload) never blocks stopping ===");
  assertEqual(
    "validationStatus omitted entirely -> DOES stop (status generated)",
    shouldStopPolling([{ status: "generated" }]),
    true
  );
  assertEqual(
    "validationStatus null -> DOES stop (status generated)",
    shouldStopPolling([{ status: "generated", validationStatus: null as unknown as string }]),
    true
  );
  assertEqual(
    "validationStatus an unrecognized/future string -> DOES stop (treated as settled, not spun on forever)",
    shouldStopPolling([{ status: "generated", validationStatus: "some-future-status" }]),
    true
  );

  console.log("\n=== Empty batch ===");
  assertEqual("no designs at all -> DOES stop", shouldStopPolling([]), true);

  console.log("\n=== isValidationInFlight() directly, against the full VALIDATION_STATUSES list ===");
  const expectedInFlight = new Set(["pending", "validating", "regenerating"]);
  for (const s of VALIDATION_STATUSES) {
    assertEqual(`isValidationInFlight("${s}")`, isValidationInFlight(s), expectedInFlight.has(s));
  }
  assertEqual("isValidationInFlight(undefined)", isValidationInFlight(undefined), false);
  assertEqual("isValidationInFlight(null)", isValidationInFlight(null), false);

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("ERROR", err);
  process.exitCode = 1;
});
