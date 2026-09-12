/**
 * Backfills slug + semantic-search embeddings onto Design rows created
 * before this feature existed. Two independent, idempotent phases — split
 * because slug generation has no failure mode and shouldn't be gated by an
 * external API's reliability:
 *
 *   npx tsx scripts/backfill-designs.ts --phase=slugs
 *   npx tsx scripts/backfill-designs.ts --phase=embeddings [--dry-run] [--limit N]
 *
 * --phase=slugs: WHERE slug IS NULL -> compute and write slugs only, no API
 * calls, safe to run in full immediately.
 *
 * --phase=embeddings: WHERE "conceptEmbedding" IS NULL -> batched, looks up
 * each row's Batch.keyword, embeds keyword/concept/backPhrase text (same
 * join as /api/generate uses, kept in sync deliberately — see
 * buildConceptText below), writes via the same per-row raw UPDATE shape.
 * Rate-limit-aware: a short delay between batches. Run --dry-run --limit 5
 * first to sanity-check before a full run.
 */
import dotenv from "dotenv";
dotenv.config();

import { prisma } from "../src/lib/prisma";
import { embedTexts, toVectorParam } from "../src/lib/embeddings";
import { designSlug } from "../src/lib/slug";

const BATCH_SIZE = 20;
const DELAY_BETWEEN_BATCHES_MS = 500;

/** Kept identical to the join in /api/generate/route.ts's enrich step. */
function buildConceptText(title: string, phrase: string, visualConcept: string): string {
  return `${title}\n${phrase}\n${visualConcept}`;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const phase = args.find((a) => a.startsWith("--phase="))?.split("=")[1];
  const dryRun = args.includes("--dry-run");
  const limitArg = args.find((a) => a.startsWith("--limit="))?.split("=")[1];
  const limit = limitArg ? parseInt(limitArg, 10) : undefined;
  return { phase, dryRun, limit };
}

async function backfillSlugs(limit?: number) {
  console.log("Phase: slugs");
  let processed = 0;
  const total = await prisma.design.count({ where: { slug: null } });
  console.log(`${total} design(s) missing a slug.`);

  while (true) {
    if (limit && processed >= limit) break;
    const take = limit ? Math.min(BATCH_SIZE, limit - processed) : BATCH_SIZE;
    const rows = await prisma.design.findMany({
      where: { slug: null },
      select: { id: true, title: true },
      take,
      orderBy: { createdAt: "asc" },
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      const slug = designSlug(row.title, row.id);
      await prisma.$executeRaw`UPDATE "Design" SET slug = ${slug} WHERE id = ${row.id}`;
    }
    processed += rows.length;
    console.log(`  slugs: processed ${processed} / ${total}`);
  }
  console.log(`Done. ${processed} row(s) slugged.`);
}

interface EmbeddingBackfillRow {
  id: string;
  batchId: string;
  title: string;
  phrase: string;
  visualConcept: string;
  backPhrase: string | null;
}

async function backfillEmbeddings(dryRun: boolean, limit?: number) {
  console.log(`Phase: embeddings${dryRun ? " (dry run)" : ""}`);
  let processed = 0;

  // conceptEmbedding is Unsupported("vector(768)") — entirely excluded from
  // the generated Prisma Client (confirmed: even an `as never`-cast `where`
  // is rejected at runtime, not just by TS), so both the count and the row
  // fetch here must be raw SQL.
  const totalRows = await prisma.$queryRaw<
    { count: bigint }[]
  >`SELECT COUNT(*)::bigint as count FROM "Design" WHERE "conceptEmbedding" IS NULL`;
  const total = Number(totalRows[0]?.count ?? 0);
  console.log(`${total} design(s) missing embeddings.`);

  while (true) {
    if (limit && processed >= limit) break;
    const take = limit ? Math.min(BATCH_SIZE, limit - processed) : BATCH_SIZE;

    const rows = await prisma.$queryRaw<EmbeddingBackfillRow[]>`
      SELECT id, "batchId", title, phrase, "visualConcept", "backPhrase"
      FROM "Design"
      WHERE "conceptEmbedding" IS NULL
      ORDER BY "createdAt" ASC
      LIMIT ${take}
    `;
    if (rows.length === 0) break;

    const batchIds = [...new Set(rows.map((r) => r.batchId))];
    const batches = await prisma.batch.findMany({
      where: { id: { in: batchIds } },
      select: { id: true, keyword: true },
    });
    const keywordByBatch = new Map(batches.map((b) => [b.id, b.keyword]));

    // One embed call per row's keyword (usually shared across a batch, but
    // simplest/safest to just embed per-row here since this script isn't
    // latency-sensitive) plus its concept and back-phrase text.
    for (const row of rows) {
      const keyword = keywordByBatch.get(row.batchId) ?? "";
      const conceptText = buildConceptText(row.title, row.phrase, row.visualConcept);
      const [keywordVec, conceptVec, backPhraseVec] = await embedTexts([
        keyword,
        conceptText,
        row.backPhrase ?? null,
      ]);

      if (dryRun) {
        console.log(
          `  [dry-run] ${row.id}: keyword=${keywordVec ? "ok" : "null"} concept=${conceptVec ? "ok" : "null"} backPhrase=${backPhraseVec ? "ok" : "null"}`
        );
      } else {
        await prisma.$executeRaw`
          UPDATE "Design"
          SET "keywordEmbedding" = ${keywordVec ? toVectorParam(keywordVec) : null}::vector,
              "conceptEmbedding" = ${conceptVec ? toVectorParam(conceptVec) : null}::vector,
              "backPhraseEmbedding" = ${backPhraseVec ? toVectorParam(backPhraseVec) : null}::vector
          WHERE id = ${row.id}
        `;
      }
    }

    processed += rows.length;
    console.log(`  embeddings: processed ${processed} / ${total}`);

    if (dryRun) break; // dry-run only samples one batch, doesn't loop over the whole table
    await new Promise((r) => setTimeout(r, DELAY_BETWEEN_BATCHES_MS));
  }
  console.log(`Done. ${processed} row(s) processed.`);
}

async function main() {
  const { phase, dryRun, limit } = parseArgs();
  if (phase === "slugs") {
    await backfillSlugs(limit);
  } else if (phase === "embeddings") {
    await backfillEmbeddings(dryRun, limit);
  } else {
    console.error("Usage: npx tsx scripts/backfill-designs.ts --phase=slugs|embeddings [--dry-run] [--limit N]");
    process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
