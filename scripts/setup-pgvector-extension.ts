/**
 * One-time, idempotent: enables the pgvector extension on this database.
 * Must run BEFORE `npx prisma db push` picks up the `vector(768)` columns on
 * Design (keywordEmbedding/conceptEmbedding/backPhraseEmbedding) — `db push`
 * has no concept of Postgres extensions and will fail if `vector` doesn't
 * already exist as a type.
 *
 * Run once per environment:
 *   npx tsx scripts/setup-pgvector-extension.ts
 *
 * Then: npx prisma db push
 * Then: npx tsx scripts/setup-pgvector-indexes.ts
 *
 * Safe to re-run — CREATE EXTENSION IF NOT EXISTS is a no-op if already
 * enabled. Neon supports the vector extension on standard projects; if this
 * fails with "extension \"vector\" is not available", check the project's
 * Postgres version/tier in the Neon console before assuming code is at fault.
 */
import dotenv from "dotenv";
dotenv.config();

import { prisma } from "../src/lib/prisma";

async function main() {
  await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS vector;`);
  console.log("pgvector extension is enabled.");
}

main()
  .catch((err) => {
    console.error("Failed to enable pgvector extension:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
