/**
 * Re-render, IN PLACE, every Design row currently stuck at status "failed".
 * Uses the same renderDesignArtwork() path /api/generate/retry uses, so it
 * redoes the full pipeline (Gemini art, product mockup composite, back
 * print) and writes fresh full-res + preview paths.
 *
 * Also picks up the shirt-shape prompt fix (src/config/prompts.ts) and any
 * transient provider issues (503/429) that have since cleared — most of the
 * current "failed" rows were exactly that: a Gemini 503, a since-fixed GCS
 * bucket misconfig, or a one-off local dev issue, not a lasting bug.
 *
 * Resets stale PrintRove state (asset ids, DesignProduct rows) so the next
 * PrintRove touch re-uploads/rebuilds against the new art.
 *
 * Costs real Gemini API calls — this is not free to re-run.
 *
 * Usage: npx tsx scripts/regenerate-failed-designs.ts
 */
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { renderDesignArtwork, isTransientProviderError } = await import("../src/lib/design-render");
  const { langfuse } = await import("../src/lib/langfuse");

  const designs = await prisma.design.findMany({ where: { status: "failed" } });
  console.log(`Regenerating ${designs.length} failed designs...`);

  // Script-only rate-limit bucket — isolated from real user/anon/admin
  // buckets so this never eats into anyone's free-generation budget.
  const rateLimit = {
    ok: true,
    tier: "admin" as const,
    bucketKey: "ratelimit:generate:script:regenerate-failed",
    windowMs: 60 * 60 * 1000,
    limit: Number.MAX_SAFE_INTEGER,
  };

  let succeeded = 0;
  let failed = 0;
  const failures: { id: string; title: string; error: string }[] = [];

  for (const design of designs) {
    const trace = langfuse.trace({
      name: "regenerate-failed-design-script",
      input: { designId: design.id },
    });

    try {
      await renderDesignArtwork(design, trace, rateLimit);
      trace.update({ output: { status: "generated" } });

      // Reset stale PrintRove state so a re-upload/rebuild happens against
      // the new art instead of silently keeping the old asset forever.
      if (design.printroveDesignId || design.printroveBackDesignId) {
        await prisma.design.update({
          where: { id: design.id },
          data: { printroveDesignId: null, printroveBackDesignId: null },
        });
      }
      const staleDesignProducts = await prisma.designProduct.findMany({
        where: {
          designId: design.id,
          OR: [{ printroveProductId: { not: null } }, { mockupFrontUrl: { not: null } }],
        },
      });
      for (const dp of staleDesignProducts) {
        await prisma.designProduct.update({
          where: { id: dp.id },
          data: {
            printroveProductId: null,
            printroveVariantId: null,
            mockupFrontUrl: null,
            mockupBackUrl: null,
            status: "pending",
            errorMessage: null,
          },
        });
      }

      succeeded++;
      console.log(`  [ok] ${design.id} (${design.title})${staleDesignProducts.length ? " (reset stale PrintRove state)" : ""}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      trace.update({ tags: ["error"], output: { error: message } });
      failed++;
      failures.push({ id: design.id, title: design.title, error: message });
      console.log(`  [FAILED] ${design.id} (${design.title}): ${message}`);
      if (!isTransientProviderError(err)) {
        await prisma.design
          .update({ where: { id: design.id }, data: { status: "failed", errorMessage: message } })
          .catch(() => {});
      }
    }
  }

  console.log(JSON.stringify({ total: designs.length, succeeded, failed, failures }, null, 2));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("ERROR", e);
  process.exitCode = 1;
});
