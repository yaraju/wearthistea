/**
 * Unit tests for src/lib/storage.ts's assertDesignPathShape() /
 * assertDesignPathFieldsShape() (issue #25) — the synchronous, static
 * shape-check that runs immediately before any DB write setting a Design
 * path field, as opposed to existsInGcs() (#17), which is an async, real
 * GCS API check.
 *
 * Sections, matching the issue's "Validation (automated)" list:
 *  1. A well-formed GCS-shaped path (`/generated/<batchId>/<file>`) passes.
 *  2. A local-disk-shaped path (an absolute filesystem path, or a relative
 *     one like `./public/generated/...`) throws, verified with a mocked DB
 *     call (spy) to confirm the write is never attempted — mirrors exactly
 *     how design-render.ts/realize.ts/the migration scripts call the guard:
 *     `assertDesignPathFieldsShape(data)` BEFORE `prisma.design.update(...)`.
 *  3. Edge cases: null/undefined/"" (the legitimate "not rendered yet"
 *     placeholder) pass through untouched; a field not present in the patch
 *     is never checked; the six real Design path field names are covered.
 *
 * No real GCS credentials or DATABASE_URL needed — pure logic + a fake
 * Prisma client.
 *
 * Usage: npx tsx scripts/test-storage-path-guard.ts
 * Exits non-zero if any assertion fails.
 */
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const { assertDesignPathShape, assertDesignPathFieldsShape, DESIGN_PATH_FIELDS } = await import(
    "../src/lib/storage"
  );

  let failures = 0;
  function check(label: string, ok: boolean, detail?: string) {
    console.log(`  [${ok ? "ok" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures++;
  }

  function throws(fn: () => void): Error | undefined {
    try {
      fn();
      return undefined;
    } catch (err) {
      return err as Error;
    }
  }

  // ── 1. Well-formed GCS-shaped paths pass ─────────────────────────────────
  console.log("=== assertDesignPathShape() — well-formed paths pass ===");
  {
    const err = throws(() => assertDesignPathShape("designImagePath", "/generated/abc123/front.png"));
    check("a normal /generated/<batchId>/<file> path doesn't throw", err === undefined, err?.message);
  }
  {
    const err = throws(() =>
      assertDesignPathShape("backDesignPreviewImagePath", "/generated/abc123/xyz-back-preview.png")
    );
    check("a preview-suffixed filename doesn't throw", err === undefined, err?.message);
  }
  {
    // Deliberately widened vs. a strict "exactly two segments" check: a
    // prod-DB audit of every existing row's segment depth was blocked by
    // this session's sandbox (production reads disallowed), so the guard
    // tolerates any depth under batchId rather than risk throwing on a
    // legitimate legacy row's shape. See storage.ts's DESIGN_PATH_SHAPE
    // comment. All current call sites (grepped across src/) only ever pass
    // a bare filename, so this branch isn't exercised today, but it must
    // not reject it.
    const err = throws(() => assertDesignPathShape("designImagePath", "/generated/abc123/nested/front.png"));
    check("a nested path under batchId doesn't throw (deliberately tolerated)", err === undefined, err?.message);
  }

  // ── 2. Local-disk-shaped / malformed paths throw ─────────────────────────
  console.log("=== assertDesignPathShape() — local-disk-shaped paths throw ===");
  const badPaths: Array<[string, string]> = [
    ["relative ./public path", "./public/generated/abc123/front.png"],
    ["bare relative public path (no leading slash)", "public/generated/abc123/front.png"],
    ["Windows absolute filesystem path", "C:\\Users\\Amanda\\Documents\\GitHub\\wearthistea\\public\\generated\\abc123\\front.png"],
    ["POSIX absolute filesystem path outside /generated", "/home/user/app/public/generated/abc123/front.png"],
    ["missing batchId segment", "/generated/front.png"],
    ["data URI instead of a path", "data:image/png;base64,iVBORw0KGgoAAAANSU"],
    ["wrong URL prefix", "/uploads/abc123/front.png"],
  ];
  for (const [label, badPath] of badPaths) {
    const err = throws(() => assertDesignPathShape("designImagePath", badPath));
    check(`"${label}" throws`, err instanceof Error, err ? undefined : "did not throw");
  }

  // ── 3. Edge cases: null/undefined/"" pass through ────────────────────────
  console.log("=== assertDesignPathShape() — legitimate empty values pass through ===");
  check("null doesn't throw (optional field genuinely unset)", throws(() => assertDesignPathShape("backDesignImagePath", null)) === undefined);
  check("undefined doesn't throw", throws(() => assertDesignPathShape("backDesignImagePath", undefined)) === undefined);
  check('"" doesn\'t throw (not-rendered-yet placeholder)', throws(() => assertDesignPathShape("designImagePath", "")) === undefined);

  // ── 4. assertDesignPathFieldsShape() — whole-payload check, write never attempted ──
  console.log("=== assertDesignPathFieldsShape() — write attempt aborted before DB call ===");

  // Fake Prisma client — records whether .update() was ever invoked, exactly
  // the "mock/spy the DB call" shape the issue's validation section asks for.
  function makeFakePrisma() {
    const calls: unknown[] = [];
    return {
      design: {
        update: async (args: unknown) => {
          calls.push(args);
          return { id: "fake" };
        },
      },
      calls,
    };
  }

  // Mirrors the real call sites' pattern exactly:
  //   assertDesignPathFieldsShape(data);
  //   return prisma.design.update({ where, data });
  async function simulateWrite(fakePrisma: ReturnType<typeof makeFakePrisma>, data: Record<string, unknown>) {
    assertDesignPathFieldsShape(data as Parameters<typeof assertDesignPathFieldsShape>[0]);
    return fakePrisma.design.update({ where: { id: "design1" }, data });
  }

  {
    const fakePrisma = makeFakePrisma();
    const goodData = {
      designImagePath: "/generated/batch1/design.png",
      designPreviewImagePath: "/generated/batch1/design-preview.png",
      productImagePath: "/generated/batch1/product.png",
      productPreviewImagePath: "/generated/batch1/product-preview.png",
      backDesignImagePath: "/generated/batch1/back.png",
      backDesignPreviewImagePath: "/generated/batch1/back-preview.png",
    };
    let threw = false;
    try {
      await simulateWrite(fakePrisma, goodData);
    } catch {
      threw = true;
    }
    check("well-formed payload: guard doesn't throw", !threw);
    check("well-formed payload: DB update WAS invoked", fakePrisma.calls.length === 1);
  }

  {
    const fakePrisma = makeFakePrisma();
    // The exact incident shape: a local-disk path (what you'd get by
    // hand-building a filesystem path instead of using saveImage()'s
    // returned URL) being written to a Design path field.
    const badData = {
      designImagePath: "./public/generated/batch1/design.png",
      designPreviewImagePath: "/generated/batch1/design-preview.png",
    };
    let threw = false;
    let message = "";
    try {
      await simulateWrite(fakePrisma, badData);
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }
    check("local-disk-shaped payload: guard throws", threw, message);
    check("local-disk-shaped payload: DB update was NEVER invoked", fakePrisma.calls.length === 0);
    check("error message names the offending field", message.includes("designImagePath"));
  }

  {
    // A patch that only touches one of the six fields (a partial update,
    // like the admin back-layout route or refix-back-designs.ts) must only
    // validate the field(s) actually present.
    const fakePrisma = makeFakePrisma();
    let threw = false;
    try {
      await simulateWrite(fakePrisma, { backDesignImagePath: "/generated/batch1/back-fixed.png" });
    } catch {
      threw = true;
    }
    check("partial payload touching only backDesignImagePath doesn't throw", !threw);
    check("partial payload: DB update WAS invoked", fakePrisma.calls.length === 1);
  }

  check(
    "DESIGN_PATH_FIELDS covers all six schema path columns",
    JSON.stringify([...DESIGN_PATH_FIELDS].sort()) ===
      JSON.stringify(
        [
          "productImagePath",
          "designImagePath",
          "productPreviewImagePath",
          "designPreviewImagePath",
          "backDesignImagePath",
          "backDesignPreviewImagePath",
        ].sort()
      )
  );

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failure(s)`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("ERROR", err);
  process.exitCode = 1;
});
