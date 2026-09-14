/**
 * Unit tests for issue #20 (version-chain awareness across public + admin
 * surfaces):
 *   - src/lib/design-versions.ts's resolveLatestDesignVersion() /
 *     getDesignVersionChain() — pure logic tests against in-memory fixtures,
 *     no DB. Each test injects its own Map-backed lookup functions instead
 *     of the module's default Prisma-backed ones, per the issue's explicit
 *     instruction: nothing sets validationStatus: "superseded" in production
 *     yet (#17-#19 haven't landed), so these must never touch the real
 *     (shared, production) DB.
 *   - src/lib/design-search.ts's buildAnnFilters() — confirms a fixture
 *     SearchOptions with excludeSuperseded: true produces a WHERE clause
 *     that actually excludes validationStatus = 'superseded' rows, and that
 *     it's opt-in (absent by default, so admin search/catalog stay
 *     unfiltered).
 *
 * Usage: npx tsx scripts/test-version-chain.ts
 * Exits non-zero if any assertion fails.
 */
import dotenv from "dotenv";
dotenv.config();

interface Node {
  id: string;
  validationStatus: string;
  regeneratedFromDesignId: string | null;
  title: string;
}

function node(id: string, validationStatus: string, regeneratedFromDesignId: string | null = null): Node {
  return { id, validationStatus, regeneratedFromDesignId, title: id };
}

/** Builds Map-backed findChild/findById lookups from a flat list of nodes —
 *  the in-memory stand-in for the DB in every test below. */
function fixtureLookups(nodes: Node[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const byParent = new Map(nodes.filter((n) => n.regeneratedFromDesignId).map((n) => [n.regeneratedFromDesignId!, n]));
  return {
    findChild: async (sourceId: string) => byParent.get(sourceId) ?? null,
    findById: async (id: string) => byId.get(id) ?? null,
  };
}

async function main() {
  const { resolveLatestDesignVersion, getDesignVersionChain } = await import("../src/lib/design-versions");
  const { buildAnnFilters } = await import("../src/lib/design-search");

  let failures = 0;
  function assertEqual(label: string, actual: unknown, expected: unknown) {
    const ok = actual === expected;
    console.log(`  [${ok ? "ok" : "FAIL"}] ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    if (!ok) failures++;
  }
  function assertTrue(label: string, ok: boolean) {
    console.log(`  [${ok ? "ok" : "FAIL"}] ${label}`);
    if (!ok) failures++;
  }

  console.log("=== resolveLatestDesignVersion() — issue #20 acceptance criteria, verbatim ===");

  // "a design with no supersession returns itself"
  {
    const a = node("A", "unjudged");
    const { findChild } = fixtureLookups([a]);
    const result = await resolveLatestDesignVersion(a, findChild);
    assertEqual("no supersession -> returns itself", result.id, "A");
  }

  // "a design superseded once returns its sibling"
  {
    const a = node("A", "superseded");
    const b = node("B", "validated", "A");
    const { findChild } = fixtureLookups([a, b]);
    const result = await resolveLatestDesignVersion(a, findChild);
    assertEqual("superseded once -> returns sibling B", result.id, "B");
  }

  // "a design superseded twice (chained) returns the final terminal sibling,
  //  not the intermediate one"
  {
    const a = node("A", "superseded");
    const b = node("B", "superseded", "A"); // B itself later superseded
    const c = node("C", "validated", "B"); // C is the true terminal
    const { findChild } = fixtureLookups([a, b, c]);
    const result = await resolveLatestDesignVersion(a, findChild);
    assertEqual("superseded twice (chained) -> returns terminal C, not intermediate B", result.id, "C");
  }

  // Starting from the middle of a chain still reaches the same terminal.
  {
    const a = node("A", "superseded");
    const b = node("B", "superseded", "A");
    const c = node("C", "validated", "B");
    const { findChild } = fixtureLookups([a, b, c]);
    const result = await resolveLatestDesignVersion(b, findChild);
    assertEqual("starting mid-chain (B) -> still resolves to terminal C", result.id, "C");
  }

  // A superseded row with no recorded successor never throws / never loops
  // forever — returns the last node actually reached.
  {
    const a = node("A", "superseded"); // no child recorded
    const { findChild } = fixtureLookups([a]);
    const result = await resolveLatestDesignVersion(a, findChild);
    assertEqual("superseded with no recorded successor -> returns itself, doesn't throw", result.id, "A");
  }

  // A cycle in bad/adversarial data terminates instead of looping forever.
  {
    const a = node("A", "superseded", "B");
    const b = node("B", "superseded", "A");
    const { findChild } = fixtureLookups([a, b]);
    const result = await resolveLatestDesignVersion(a, findChild);
    assertTrue("cyclic chain terminates instead of hanging", result.id === "A" || result.id === "B");
  }

  console.log("\n=== getDesignVersionChain() — full lineage, both directions ===");

  {
    const a = node("A", "superseded");
    const b = node("B", "superseded", "A");
    const c = node("C", "validated", "B");
    const { findChild, findById } = fixtureLookups([a, b, c]);

    // Requested from the middle (B) — chain should still cover A -> B -> C.
    const chain = await getDesignVersionChain(b, { findChild, findById });
    assertEqual("chain length", chain.length, 3);
    assertEqual("chain order[0]", chain[0].design.id, "A");
    assertEqual("chain order[1]", chain[1].design.id, "B");
    assertEqual("chain order[2]", chain[2].design.id, "C");
    assertTrue("only C marked isLatest", chain.filter((e) => e.isLatest).map((e) => e.design.id).join(",") === "C");
    assertTrue("only B marked isRequested", chain.filter((e) => e.isRequested).map((e) => e.design.id).join(",") === "B");
  }

  {
    // No supersession at all -> chain of exactly one entry, itself.
    const a = node("A", "validated");
    const { findChild, findById } = fixtureLookups([a]);
    const chain = await getDesignVersionChain(a, { findChild, findById });
    assertEqual("unsupported/no-chain design -> chain of 1", chain.length, 1);
    assertTrue("that one entry is both latest and requested", chain[0].isLatest && chain[0].isRequested);
  }

  console.log("\n=== design-search.ts buildAnnFilters() — search/gallery exclusion ===");

  {
    const filters = buildAnnFilters({ limit: 10, excludeSuperseded: true });
    const rendered = filters.map((f) => f.sql).join(" AND ");
    assertTrue(
      'excludeSuperseded: true -> WHERE clause excludes validationStatus = superseded',
      rendered.includes('"validationStatus"') && rendered.includes("superseded")
    );
  }

  {
    const filters = buildAnnFilters({ limit: 10 });
    const rendered = filters.map((f) => f.sql).join(" AND ");
    assertTrue(
      "excludeSuperseded omitted -> no superseded exclusion (admin search/catalog stay unfiltered)",
      !rendered.includes("superseded")
    );
  }

  {
    const filters = buildAnnFilters({ limit: 10, excludeSuperseded: false });
    const rendered = filters.map((f) => f.sql).join(" AND ");
    assertTrue("excludeSuperseded: false -> no superseded exclusion", !rendered.includes("superseded"));
  }

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("ERROR", err);
  process.exitCode = 1;
});
