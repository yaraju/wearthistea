/**
 * One-time migration: re-render, IN PLACE, the art for designs whose full-res
 * source files are gone from storage entirely (not just missing previews —
 * see backfill-preview-images.ts for that case). All 152 affected designs
 * were created before the Sept 4 2026 GCS migration (33c5ec7) and are
 * pre-launch test/dev batches — confirmed no live customer orders mid-
 * processing, so this intentionally includes designs that already have a
 * PrintRove asset or a (failed/rejected/unpaid) order attached, not just the
 * untouched ones.
 *
 * Uses the same renderDesignArtwork() path /api/generate/retry uses, so it
 * redoes the full pipeline (Gemini art, product mockup composite, back
 * print) and writes fresh full-res + preview paths.
 *
 * For any design that already had a printroveDesignId/printroveBackDesignId
 * (art was previously uploaded to PrintRove) or a DesignProduct row with a
 * built product/mockup, this also clears those so the next PrintRove touch
 * re-uploads and rebuilds against the NEW art instead of silently keeping
 * the old, now-mismatched asset around forever (ensureDesignProduct in
 * design-products.ts short-circuits and reuses a row that already has a
 * mockupFrontUrl, regardless of whether the underlying art changed).
 *
 * Costs real Gemini API calls — this is not free to re-run.
 *
 * Usage: npx tsx scripts/regenerate-missing-designs.ts <ids-json-file>
 *   where <ids-json-file> is a JSON array of design ids to regenerate.
 */
import dotenv from "dotenv";
dotenv.config();
import fs from "node:fs";

async function main() {
  const idsFile = process.argv[2];
  if (!idsFile) {
    console.error("Usage: npx tsx scripts/regenerate-missing-designs.ts <ids-json-file>");
    process.exit(1);
  }
  const ids = JSON.parse(fs.readFileSync(idsFile, "utf8")) as string[];
  console.log(`Regenerating ${ids.length} designs...`);

  const { prisma } = await import("../src/lib/prisma");
  const { renderDesignArtwork, isTransientProviderError } = await import("../src/lib/design-render");
  const { langfuse } = await import("../src/lib/langfuse");

  // Script-only rate-limit bucket — isolated from real user/anon/admin
  // buckets so this never eats into anyone's free-generation budget.
  const rateLimit = {
    ok: true,
    tier: "admin" as const,
    bucketKey: "ratelimit:generate:script:regenerate-missing",
    windowMs: 60 * 60 * 1000,
  };

  let succeeded = 0;
  let failed = 0;
  const failures: { id: string; error: string }[] = [];

  for (const id of ids) {
    const design = await prisma.design.findUnique({ where: { id } });
    if (!design) {
      console.log(`  [skip] ${id} not found`);
      continue;
    }

    if (design.status === "rejected") {
      console.log(`  [skip] ${id} (${design.title}) — status is rejected, leaving as-is`);
      continue;
    }

    const trace = langfuse.trace({
      name: "regenerate-missing-design-script",
      input: { designId: id },
    });

    try {
      await renderDesignArtwork(design, trace, rateLimit);
      trace.update({ output: { status: "generated" } });

      // Reset stale PrintRove state so a re-upload/rebuild happens against
      // the new art instead of silently keeping the old asset forever.
      if (design.printroveDesignId || design.printroveBackDesignId) {
        await prisma.design.update({
          where: { id },
          data: { printroveDesignId: null, printroveBackDesignId: null },
        });
      }
      const staleDesignProducts = await prisma.designProduct.findMany({
        where: {
          designId: id,
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
      console.log(`  [ok] ${id} (${design.title})${staleDesignProducts.length ? " (reset stale PrintRove state)" : ""}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      trace.update({ tags: ["error"], output: { error: message } });
      failed++;
      failures.push({ id, error: message });
      console.log(`  [FAILED] ${id} (${design.title}): ${message}`);
      if (!isTransientProviderError(err)) {
        await prisma.design
          .update({ where: { id }, data: { status: "failed", errorMessage: message } })
          .catch(() => {});
      }
    }
  }

  console.log(JSON.stringify({ total: ids.length, succeeded, failed, failures }, null, 2));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("ERROR", e);
  process.exitCode = 1;
});
