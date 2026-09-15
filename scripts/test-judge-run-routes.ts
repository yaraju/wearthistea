/**
 * Route-level validation for issue #19's /api/admin/judge-runs/* handlers —
 * the actual Next.js route.ts files, imported and invoked directly (not
 * reimplemented against a fake) the same way Next itself would call them.
 *
 * Confirmed feasible by direct spike before writing this: `@/`-aliased
 * imports resolve fine under `npx tsx` (this repo's tsconfig `paths` are
 * honored), and calling an exported GET/POST/PATCH with a plain `Request`
 * works with zero Next.js runtime needed. What's NOT reachable this way,
 * deliberately: every /api/admin/* route's first line is requireAdmin()
 * (src/lib/auth.ts), which needs a real, verified Firebase session cookie —
 * there is no fake/injectable seam for it (by design: it's the literal
 * security boundary, see AGENTS.md), and this script must never carry real
 * admin credentials or make a real Firebase network call. So this file
 * proves the auth gate itself — every route 401s with no cookie, before
 * ever touching prisma/Cloud Tasks — which is the one thing safe to assert
 * against the REAL route.ts without a real DB or real session:
 *   1. GET/POST /api/admin/judge-runs -> 401 unauthenticated
 *   2. GET/PATCH /api/admin/judge-runs/[id] -> 401 unauthenticated
 *   3. POST .../flagged/[designId]/regenerate -> 401 unauthenticated
 * The actual authenticated business logic (run creation/progress/mode-
 * freeze/regenerate preconditions) is covered at the lib layer instead —
 * see scripts/test-judge-run.ts — exactly the split this repo already uses
 * for every other /api/admin/* route (none of which have their own
 * authenticated route-level tests either; see e.g. rate-limits/route.ts's
 * logic living in src/lib/rate-limit.ts).
 *
 * Usage: npx tsx scripts/test-judge-run-routes.ts
 * Exits non-zero if any assertion fails.
 */
// Forces this file to be treated as an ES module (not a global script) —
// without any top-level static import/export, TS's module-vs-script
// auto-detection falls back to global scope, which collides with any other
// same-named top-level declaration (`main`) in another script-mode file
// under a whole-project `tsc --noEmit` (found colliding with the pre-
// existing scripts/test-poll-stop-condition.ts, which has the same trait —
// neither file ever surfaced this alone since each was previously the only
// script-mode file with that exact shape).
export {};

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  [${ok ? "ok" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function expect401(label: string, fn: () => Promise<Response>) {
  const res = await fn();
  const body = await res.json().catch(() => ({}));
  check(`${label} -> 401`, res.status === 401, `got ${res.status}: ${JSON.stringify(body)}`);
}

async function main() {
  const listRoute = await import("../src/app/api/admin/judge-runs/route");
  const oneRoute = await import("../src/app/api/admin/judge-runs/[id]/route");
  const regenRoute = await import("../src/app/api/admin/judge-runs/[id]/flagged/[designId]/regenerate/route");

  console.log("=== /api/admin/judge-runs — unauthenticated requests are rejected ===");
  await expect401("GET  /api/admin/judge-runs", () => listRoute.GET(new Request("http://localhost/api/admin/judge-runs")));
  await expect401("POST /api/admin/judge-runs", () =>
    listRoute.POST(
      new Request("http://localhost/api/admin/judge-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ statusFilter: "unjudged", limit: 5, mode: "manual" }),
      })
    )
  );

  console.log("\n=== /api/admin/judge-runs/[id] — unauthenticated requests are rejected ===");
  await expect401("GET   /api/admin/judge-runs/[id]", () =>
    oneRoute.GET(new Request("http://localhost/api/admin/judge-runs/run-1"), { params: Promise.resolve({ id: "run-1" }) })
  );
  await expect401("PATCH /api/admin/judge-runs/[id]", () =>
    oneRoute.PATCH(
      new Request("http://localhost/api/admin/judge-runs/run-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "auto" }),
      }),
      { params: Promise.resolve({ id: "run-1" }) }
    )
  );

  console.log("\n=== .../flagged/[designId]/regenerate — unauthenticated requests are rejected ===");
  await expect401("POST /api/admin/judge-runs/[id]/flagged/[designId]/regenerate", () =>
    regenRoute.POST(
      new Request("http://localhost/api/admin/judge-runs/run-1/flagged/d1/regenerate", { method: "POST" }),
      { params: Promise.resolve({ id: "run-1", designId: "d1" }) }
    )
  );

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("ERROR", err);
  process.exitCode = 1;
});
