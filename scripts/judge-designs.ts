/**
 * Bulk judge runner (issue #18) — runs design-judge.ts's judgeDesign() (#12)
 * plus design-judge-bulk.ts's bulk-only rubrics (#17: integrity audit,
 * style-alignment re-check, stuck-generation staleness) against the
 * existing Design backlog, and reports per-rubric pass percentages in
 * scripts/eval-designs.ts's SUMMARY style.
 *
 * Defaults to `validationStatus = 'unjudged'`, dry-run/report-only — no
 * writes happen anywhere in this file, or in src/lib/judge-designs-runner.ts
 * (the module that actually decides + acts per design), unless --apply is
 * passed. See judge-designs-runner.ts's judgeOneDesign(): every store write
 * it can reach is inside an `if (apply)` branch.
 *
 * On --apply: a design that fails the judge gets a fresh sibling Design
 * (never an in-place mutation of the original — see judge-designs-
 * runner.ts's top doc comment for why this deliberately does NOT reuse
 * validation-chain.ts's in-place programmatic-fix routing), linked via
 * regeneratedFromDesignId, with the original flipped to "superseded"; a
 * design already attached to a placed Order or a live/fulfilled
 * DesignProduct is flagged for admin review instead of auto-fixed
 * (judge-designs-runner.ts's computeExclusion()). If a design passes
 * as-is, its validationStatus flips to "validated" in place.
 *
 * Uses an isolated script-only rate-limit bucket for any sibling render
 * this triggers (bucketKey "ratelimit:generate:script:judge-designs") — same
 * pattern as scripts/regenerate-failed-designs.ts:32-38 — so a bulk --apply
 * run never eats into real user/anon/admin generation budgets.
 *
 * Costs real Gemini API calls (one judge call + one style-alignment call per
 * "generated" design in scope, plus a full render per sibling created under
 * --apply) — --limit defaults to a small number to keep an unqualified run
 * cheap; pass a larger --limit deliberately for a bigger sweep.
 *
 * Usage: npx tsx scripts/judge-designs.ts [--status <filter>] [--apply] [--limit N]
 *
 * Integrity checks (auditDesignIntegrity) need GCS_BUCKET set — pass it on
 * the command line, never add it to .env (see AGENTS.md's GCS_BUCKET
 * gotcha):
 *   GCS_BUCKET="wearthistea-designs-wearthistea" npx tsx scripts/judge-designs.ts --limit 5
 * Without it, this script simply skips the integrity rubric for every
 * design (reported as "no designs checked") rather than crashing or
 * reporting false failures.
 */
import type { Design } from "@prisma/client";
import type { JudgeVerdict } from "../src/lib/design-judge";
import dotenv from "dotenv";
dotenv.config();

const DEFAULT_LIMIT = 25;

function parseArgs(argv: string[]) {
  const statusIdx = argv.indexOf("--status");
  const status = statusIdx >= 0 ? argv[statusIdx + 1] : "unjudged";
  const apply = argv.includes("--apply");
  const limitIdx = argv.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(argv[limitIdx + 1]) : DEFAULT_LIMIT;
  return { status, apply, limit };
}

async function main() {
  const { status, apply, limit } = parseArgs(process.argv.slice(2));

  if (!Number.isFinite(limit) || limit <= 0) {
    console.error(`Invalid --limit: must be a positive number (got "${limit}").`);
    process.exit(1);
  }

  const { VALIDATION_STATUSES } = await import("../src/lib/validation-status");
  if (!(VALIDATION_STATUSES as readonly string[]).includes(status)) {
    console.error(
      `Invalid --status "${status}" — must be one of: ${VALIDATION_STATUSES.join(", ")}.`
    );
    process.exit(1);
  }

  const { prisma } = await import("../src/lib/prisma");
  const { judgeOneDesign, computeExclusion } = await import("../src/lib/judge-designs-runner");
  const { prismaDesignStore, loadDesignImageBase64 } = await import("../src/lib/validation-chain");
  const { buildRegenerationEdit } = await import("../src/lib/design-regenerate");
  const { buildRubricReport, formatRubricSummary } = await import("../src/lib/design-judge-bulk");
  const { hasDurableStorage } = await import("../src/lib/storage");

  console.log(`\n=== judge-designs: status="${status}" apply=${apply} limit=${limit} ===`);
  if (!hasDurableStorage) {
    console.log(
      `[judge-designs] GCS_BUCKET is not set — the integrity rubric will be skipped for every design ` +
        `(pass it explicitly on the command line to include it; see this file's header comment).`
    );
  }

  const designs = await prisma.design.findMany({
    where: { validationStatus: status },
    // `id` as a tiebreaker makes this ordering stable across runs (several
    // rows in the same batch share a near-identical createdAt) — load-
    // bearing for the dry-run -> human-review -> --apply workflow: the same
    // --limit N must return the same slice both times.
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit,
    include: {
      orders: { select: { status: true } },
      designProducts: { select: { status: true, approvalStatus: true } },
    },
  });

  console.log(`Found ${designs.length} design(s) at validationStatus="${status}".\n`);

  // Isolated script-only rate-limit bucket for any sibling render triggered
  // by --apply — deliberately NOT validation-chain.ts's own default
  // renderFn (that one spends from the live task queue's
  // "ratelimit:generate:task:regenerate-design" bucket). Mirrors
  // regenerate-failed-designs.ts:32-38 / design-judge-bulk.ts's
  // flagAndTriggerStuckDesign().
  async function scriptRenderFn(sibling: Design, source: Design, verdict: JudgeVerdict): Promise<Design> {
    const { renderDesignArtwork } = await import("../src/lib/design-render");
    const { langfuse } = await import("../src/lib/langfuse");
    const trace = langfuse.trace({ name: "judge-designs-script", input: { designId: sibling.id } });
    const rateLimit = {
      ok: true as const,
      tier: "admin" as const,
      bucketKey: "ratelimit:generate:script:judge-designs",
      windowMs: 60 * 60 * 1000,
      limit: Number.MAX_SAFE_INTEGER,
    };
    let edit: { sourceImageB64: string; instruction: string } | undefined;
    try {
      const sourceImageB64 = await loadDesignImageBase64(source);
      edit = { sourceImageB64, instruction: buildRegenerationEdit(verdict).instruction };
    } catch (err) {
      console.error(
        `  [judge-designs] couldn't load source image for a targeted edit on ${source.id} -> ${sibling.id}, ` +
          `falling back to a from-scratch re-roll: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return renderDesignArtwork(sibling, trace, rateLimit, edit);
  }

  const verdicts: Parameters<typeof buildRubricReport>[0] = [];
  const counts: Record<string, number> = {};
  let integrityChecked = 0;
  let integrityLostObjects = 0;
  let integrityMissingFieldsOnly = 0;

  for (const design of designs) {
    const exclusion = computeExclusion(design.orders, design.designProducts);
    const result = await judgeOneDesign(design, exclusion, apply, {
      store: prismaDesignStore,
      renderFn: scriptRenderFn,
    });
    verdicts.push(result.verdict);
    counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
    if (result.integrityDetail) {
      integrityChecked++;
      if (result.integrityDetail.hasLostObjects) integrityLostObjects++;
      else if (result.integrityDetail.hasMissingFields) integrityMissingFieldsOnly++;
    }
    console.log(`  [${result.outcome}] ${design.id} (${design.title}) — ${result.detail}`);
  }

  console.log(`\n=== Outcome counts ===`);
  for (const [outcome, n] of Object.entries(counts)) console.log(`  ${outcome}: ${n}`);

  console.log(`\n${formatRubricSummary(buildRubricReport(verdicts))}`);
  if (integrityChecked > 0) {
    // auditDesignIntegrity()'s own doc comment: a failing `passed` conflates
    // a genuine loss (hasLostObjects — a DB path pointing at a file that
    // isn't actually in GCS, the real incident this check exists to catch)
    // with a row that simply predates a feature (hasMissingFields only,
    // e.g. no back print yet on an old row) — break them out so the
    // integrity rubric line above never reads as "half the catalog is
    // broken" when it's actually all benign legacy rows.
    console.log(
      `  (of ${integrityChecked} integrity-checked: ${integrityLostObjects} with a genuine lost/missing-from-GCS ` +
        `object, ${integrityMissingFieldsOnly} legacy rows only missing a not-yet-backfilled field)`
    );
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("ERROR", err);
  process.exitCode = 1;
});
