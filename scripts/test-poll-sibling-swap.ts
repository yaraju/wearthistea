/**
 * Unit test for mergePolledDesigns() (src/lib/validation-status.ts), added
 * for issue #32: KeywordStudio.tsx's pollBatchStatus() never surfaced a
 * regenerated sibling created by the judge/fix/regenerate chain (#13) —
 * once a design's validationStatus flipped to "superseded" the grid kept
 * showing that design's own (stale, unchanged) art forever, because the old
 * merge only matched polled rows by the FIXED set of ids the client learned
 * about from the original /api/generate call, and a sibling's id never
 * appears in that set.
 *
 * Pure logic test — no DB, no network, no React. Follows the same shape as
 * scripts/test-poll-stop-condition.ts (also exercising
 * src/lib/validation-status.ts, the module shared by pollBatchStatus() and
 * its mount-restore effect).
 *
 * Usage: npx tsx scripts/test-poll-sibling-swap.ts
 * Exits non-zero if any assertion fails.
 */

// Forces this file into its own module scope (no top-level static import
// otherwise) — without this, tsc treats it as a global script, and its
// top-level `main()` collides with test-poll-stop-condition.ts's own
// same-named global `main()` under `npx tsc --noEmit` (see
// scripts/test-judge-run-routes.ts for the same precedent).
export {};

async function main() {
  const { mergePolledDesigns } = await import("../src/lib/validation-status");

  let failures = 0;
  function assertEqual(label: string, actual: unknown, expected: unknown) {
    const ok = actual === expected;
    console.log(`  [${ok ? "ok" : "FAIL"}] ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    if (!ok) failures++;
  }

  // Minimal design fixture — enough fields to exercise the merge and to
  // stand in for DesignDTO's image-path fields the issue calls out.
  function design(overrides: Record<string, unknown>) {
    return {
      id: "id-missing",
      title: "Untitled",
      validationStatus: "unjudged" as string | null,
      regeneratedFromDesignId: null as string | null,
      designPreviewImagePath: "",
      productPreviewImagePath: "",
      ...overrides,
    };
  }

  console.log("=== Issue #32: a single supersession swaps in the resolved sibling ===");
  {
    const original = design({
      id: "orig",
      validationStatus: "superseded",
      designPreviewImagePath: "/orig-design-preview.png",
      productPreviewImagePath: "/orig-product-preview.png",
    });
    const sibling = design({
      id: "sib",
      validationStatus: "validated",
      regeneratedFromDesignId: "orig",
      designPreviewImagePath: "/sib-design-preview.png",
      productPreviewImagePath: "/sib-product-preview.png",
    });

    const prevDesigns = [design({ id: "orig", validationStatus: "pending" })];
    const polledDesigns = [original, sibling];

    const merged = mergePolledDesigns(prevDesigns, polledDesigns);
    assertEqual("same slot count", merged.length, 1);
    assertEqual("slot swaps to sibling's id", merged[0].id, "sib");
    assertEqual("slot swaps to sibling's validationStatus", merged[0].validationStatus, "validated");
    assertEqual("slot swaps to sibling's designPreviewImagePath", merged[0].designPreviewImagePath, "/sib-design-preview.png");
    assertEqual("slot swaps to sibling's productPreviewImagePath", merged[0].productPreviewImagePath, "/sib-product-preview.png");
  }

  console.log("\n=== Multi-hop chain: sibling itself superseded by a second sibling ===");
  {
    const original = design({ id: "orig", validationStatus: "superseded" });
    const sibling1 = design({
      id: "sib1",
      validationStatus: "superseded",
      regeneratedFromDesignId: "orig",
      designPreviewImagePath: "/sib1-design-preview.png",
    });
    const sibling2 = design({
      id: "sib2",
      validationStatus: "validated",
      regeneratedFromDesignId: "sib1",
      designPreviewImagePath: "/sib2-design-preview.png",
      productPreviewImagePath: "/sib2-product-preview.png",
    });

    const prevDesigns = [design({ id: "orig", validationStatus: "pending" })];
    // Order shouldn't matter — shuffle so the walk can't accidentally rely
    // on array order matching chain order.
    const polledDesigns = [sibling2, original, sibling1];

    const merged = mergePolledDesigns(prevDesigns, polledDesigns);
    assertEqual("multi-hop resolves to the FINAL sibling's id, not the intermediate one", merged[0].id, "sib2");
    assertEqual("multi-hop resolves to the final sibling's validationStatus", merged[0].validationStatus, "validated");
    assertEqual("multi-hop resolves to the final sibling's image path", merged[0].designPreviewImagePath, "/sib2-design-preview.png");
  }

  console.log("\n=== Sibling not in this poll response yet -> falls back to the in-place update, doesn't throw ===");
  {
    const original = design({ id: "orig", validationStatus: "superseded", designPreviewImagePath: "/orig.png" });
    const prevDesigns = [design({ id: "orig", validationStatus: "regenerating" })];
    const polledDesigns = [original]; // no sibling row present yet

    let threw = false;
    let merged: ReturnType<typeof mergePolledDesigns> = [];
    try {
      merged = mergePolledDesigns(prevDesigns, polledDesigns);
    } catch {
      threw = true;
    }
    assertEqual("does not throw when no sibling is resolvable yet", threw, false);
    assertEqual("falls back to the superseded original's own id", merged[0]?.id, "orig");
    assertEqual("falls back to the superseded original's own validationStatus", merged[0]?.validationStatus, "superseded");
  }

  console.log("\n=== Cycle guard: a bad/dangling regeneratedFromDesignId loop never hangs ===");
  {
    // Pathological data that shouldn't occur in practice (regeneratedFromDesignId
    // is @unique in the DB) but the walk must still terminate defensively.
    const a = design({ id: "a", validationStatus: "superseded", regeneratedFromDesignId: "b" });
    const b = design({ id: "b", validationStatus: "superseded", regeneratedFromDesignId: "a" });
    const prevDesigns = [design({ id: "a", validationStatus: "pending" })];
    const polledDesigns = [a, b];

    let threw = false;
    let merged: ReturnType<typeof mergePolledDesigns> = [];
    try {
      merged = mergePolledDesigns(prevDesigns, polledDesigns);
    } catch {
      threw = true;
    }
    assertEqual("does not throw/hang on a cyclic chain", threw, false);
    assertEqual("stops on a repeat id (lands on 'b', the first hop from 'a')", merged[0]?.id, "b");
  }

  console.log("\n=== Every other validationStatus is passed through unchanged (scoped to 'superseded' only) ===");
  for (const status of ["pending", "validating", "regenerating", "validated", "rejected", "unjudged"]) {
    const polled = design({ id: "x", validationStatus: status, designPreviewImagePath: "/x.png" });
    const prevDesigns = [design({ id: "x", validationStatus: "pending" })];
    const merged = mergePolledDesigns(prevDesigns, [polled]);
    assertEqual(`validationStatus "${status}" -> id unchanged`, merged[0].id, "x");
    assertEqual(`validationStatus "${status}" -> validationStatus carried through as-is`, merged[0].validationStatus, status);
    assertEqual(`validationStatus "${status}" -> image path carried through as-is`, merged[0].designPreviewImagePath, "/x.png");
  }

  console.log("\n=== A design whose id no longer appears in the poll response at all is left untouched ===");
  {
    const prevDesigns = [design({ id: "gone", validationStatus: "pending", title: "Still here" })];
    const merged = mergePolledDesigns(prevDesigns, []);
    assertEqual("untouched id", merged[0].id, "gone");
    assertEqual("untouched title", merged[0].title, "Still here");
  }

  console.log("\n=== A partial polled payload (missing a column resolved carries) still spreads the prev slot's own copy of it ===");
  {
    // In production every column is always present on a polled row (the
    // status endpoint spreads the whole DB row minus a fixed exclusion
    // list — see /api/generate/status), so this is a defensive-spread check
    // for a partial/malformed payload, not something that leaks stale data
    // across ids in the normal case.
    const prevDesigns = [design({ id: "orig", validationStatus: "pending", slug: "orig-slug" } as any)];
    const sibling = design({ id: "sib", validationStatus: "validated", regeneratedFromDesignId: "orig" });
    delete (sibling as any).slug;
    const original = design({ id: "orig", validationStatus: "superseded" });
    const merged = mergePolledDesigns(prevDesigns, [original, sibling]) as any[];
    assertEqual("resolved sibling id wins", merged[0].id, "sib");
    assertEqual("prev slot's own copy of a field absent on the resolved row still comes through", merged[0].slug, "orig-slug");
  }

  console.log("\n=== Mount-restore path: prevDesigns already contains BOTH the superseded original AND its sibling as separate slots ===");
  {
    // KeywordStudio.tsx's mount-restore effect seeds `result` (and thus the
    // next poll's prevDesigns) straight from a raw /api/generate/status
    // payload -- every row for the batch, not just the original fixed ids
    // -- so a mid-chain reload can hand mergePolledDesigns both an original
    // and its already-created sibling as two separate prevDesigns slots.
    // Without de-duping, the original's slot would resolve forward to that
    // same sibling, producing two grid entries with the same id/React key.
    const orig = design({ id: "orig", validationStatus: "superseded" });
    const sib = design({ id: "sib", validationStatus: "pending", regeneratedFromDesignId: "orig" });
    const prevDesigns = [orig, sib];
    const polledDesigns = [orig, sib];

    const merged = mergePolledDesigns(prevDesigns, polledDesigns);
    assertEqual("no duplicate slot -> exactly one entry", merged.length, 1);
    assertEqual("the surviving entry is the sibling", merged[0].id, "sib");
  }

  console.log("\n=== Mount-restore path, chain already fully settled: no design is in-flight, so pollBatchStatus() never runs -- the restore effect's own self-merge is the ONLY place this ever resolves ===");
  {
    const orig = design({ id: "orig", validationStatus: "superseded" });
    const sib = design({ id: "sib", validationStatus: "validated", regeneratedFromDesignId: "orig" });
    // Mirrors KeywordStudio.tsx's restore effect: mergePolledDesigns(data.designs, data.designs).
    const merged = mergePolledDesigns([orig, sib], [orig, sib]);
    assertEqual("settled restore -> exactly one entry, not two stale+resolved cards", merged.length, 1);
    assertEqual("settled restore -> surviving entry is the validated sibling", merged[0].id, "sib");
    assertEqual("settled restore -> surviving entry's own validationStatus", merged[0].validationStatus, "validated");
  }

  console.log("\n=== Mount-restore path, multi-hop: original + intermediate sibling + final sibling all present as separate prevDesigns slots ===");
  {
    const orig = design({ id: "orig", validationStatus: "superseded" });
    const sib1 = design({ id: "sib1", validationStatus: "superseded", regeneratedFromDesignId: "orig" });
    const sib2 = design({ id: "sib2", validationStatus: "validated", regeneratedFromDesignId: "sib1" });
    const prevDesigns = [orig, sib1, sib2];
    const polledDesigns = [orig, sib1, sib2];

    const merged = mergePolledDesigns(prevDesigns, polledDesigns);
    assertEqual("no duplicate slots across a multi-hop restore -> exactly one entry", merged.length, 1);
    assertEqual("the surviving entry is the final sibling", merged[0].id, "sib2");
  }

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("ERROR", err);
  process.exitCode = 1;
});
