/**
 * One-time, idempotent: creates HNSW ANN indexes on Design's three vector
 * columns. Must run AFTER `npx prisma db push` has created those columns
 * (see scripts/setup-pgvector-extension.ts for the full 3-step runbook:
 * extension -> db push -> indexes).
 *
 * HNSW, not IVFFlat: IVFFlat's list-training needs representative data
 * present at index-creation time, and this runs before any embeddings have
 * been backfilled. Opclass is vector_cosine_ops to match the `<=>` cosine
 * distance operator used everywhere in src/lib/design-search.ts — a
 * mismatched opclass (e.g. vector_l2_ops) silently falls back to a
 * sequential scan with no error, which is easy to miss at small row counts.
 *
 * Run once per environment, after `npx prisma db push`:
 *   npx tsx scripts/setup-pgvector-indexes.ts
 *
 * Re-run after any future `prisma db push` to confirm these three indexes
 * still exist — Prisma has no knowledge of them and will not warn you if a
 * push ever drops/recreates the table.
 */
import dotenv from "dotenv";
dotenv.config();

import { prisma } from "../src/lib/prisma";

const INDEXES: Array<{ name: string; column: string }> = [
  { name: "design_keyword_embedding_hnsw", column: "keywordEmbedding" },
  { name: "design_concept_embedding_hnsw", column: "conceptEmbedding" },
  { name: "design_backphrase_embedding_hnsw", column: "backPhraseEmbedding" },
];

async function main() {
  for (const { name, column } of INDEXES) {
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS ${name} ON "Design" USING hnsw ("${column}" vector_cosine_ops);`
    );
    console.log(`Ensured index ${name} on Design.${column}`);
  }
}

main()
  .catch((err) => {
    console.error("Failed to create pgvector indexes:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
