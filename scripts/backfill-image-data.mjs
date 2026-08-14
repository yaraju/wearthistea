/**
 * Backfill designImageData for designs whose file still exists on disk.
 *
 * Run where STORAGE_DIR and DATABASE_URL are set:
 *   node scripts/backfill-image-data.mjs
 *
 * Safe to run multiple times — skips designs that already have the field set.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const STORAGE_DIR =
  process.env.STORAGE_DIR ?? path.join(process.cwd(), "public", "generated");

function resolveStoragePath(publicPath) {
  const rel = publicPath.replace(/^\/generated\/?/, "");
  return path.join(STORAGE_DIR, rel);
}

async function main() {
  const designs = await prisma.design.findMany({
    where: {
      designImageData: null,
      NOT: { designImagePath: "" },
    },
    select: { id: true, designImagePath: true },
  });

  console.log(`Found ${designs.length} design(s) without image data.`);

  let updated = 0;
  let skipped = 0;

  for (const design of designs) {
    if (!design.designImagePath) { skipped++; continue; }

    const filePath = resolveStoragePath(design.designImagePath);
    let buffer;
    try {
      buffer = await readFile(filePath);
    } catch {
      console.log(`  MISSING  ${design.id}  (${filePath})`);
      skipped++;
      continue;
    }

    const base64 = buffer.toString("base64");
    await prisma.design.update({
      where: { id: design.id },
      data: { designImageData: base64 },
    });
    console.log(`  OK       ${design.id}  (${Math.round(buffer.length / 1024)} KB)`);
    updated++;
  }

  console.log(`\nDone. Updated: ${updated}, skipped/missing: ${skipped}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
