/**
 * One-time cleanup: Design.designImageData (a base64 copy of the print-ready
 * art, stored as a fallback for when the on-disk file is missing) is what's
 * filling up Neon's storage — 413MB of a 512MB cap, almost entirely this
 * column, verified via pg_total_relation_size during the printrove-previews
 * work. Production already has a durable GCS bucket
 * (wearthistea-designs-wearthistea) wired up via GCS_BUCKET, so this base64
 * copy is redundant, not a real safety net, for any design whose
 * designImagePath is already durably saved there.
 *
 * For each Design with designImageData set:
 *   1. Check whether its designImagePath already exists in GCS.
 *   2. If yes — the real file is safe, just null out the DB column.
 *   3. If no — upload the base64 data to that exact path (recreating the
 *      "lost" file for real), verify the upload, then null out the column.
 *
 * Run with: npx tsx scripts/migrate-design-image-data-to-gcs.ts [--dry-run]
 */
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  if (!process.env.GCS_BUCKET) {
    process.env.GCS_BUCKET = "wearthistea-designs-wearthistea";
    console.log(`GCS_BUCKET not set locally — defaulting to ${process.env.GCS_BUCKET}`);
  }

  const { Storage } = await import("@google-cloud/storage");
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  const storage = new Storage();
  const bucket = storage.bucket(process.env.GCS_BUCKET);

  const designs = await prisma.design.findMany({
    where: { designImageData: { not: null } },
    select: { id: true, designImagePath: true, designImageData: true },
  });
  console.log(`Found ${designs.length} designs with designImageData set.${dryRun ? " (dry run)" : ""}`);

  let alreadySafe = 0;
  let reuploaded = 0;
  let failed = 0;

  for (const d of designs) {
    const relPath = d.designImagePath.replace(/^\/generated\/?/, "");
    if (!relPath) {
      console.error(`  [${d.id}] no designImagePath — skipping, leaving designImageData as-is`);
      failed++;
      continue;
    }

    try {
      const file = bucket.file(relPath);
      const [exists] = await file.exists();

      if (!exists) {
        console.log(`  [${d.id}] ${relPath} missing in GCS — re-uploading from designImageData`);
        if (!dryRun) {
          const buffer = Buffer.from(d.designImageData!, "base64");
          await file.save(buffer, { contentType: "image/png", resumable: false });
          const [nowExists] = await file.exists();
          if (!nowExists) throw new Error("Upload reported success but file still doesn't exist.");
        }
        reuploaded++;
      } else {
        alreadySafe++;
      }

      if (!dryRun) {
        await prisma.design.update({ where: { id: d.id }, data: { designImageData: null } });
      }
    } catch (err) {
      console.error(`  [${d.id}] FAILED:`, err instanceof Error ? err.message : err);
      failed++;
    }
  }

  console.log("\nSummary:");
  console.log(`  already safe in GCS, base64 cleared: ${alreadySafe}`);
  console.log(`  missing in GCS, re-uploaded + cleared: ${reuploaded}`);
  console.log(`  failed (designImageData left intact): ${failed}`);

  // Nulling designImageData with UPDATE doesn't shrink the table on its
  // own — Postgres MVCC leaves the old (huge) row version as dead space
  // until vacuumed. Without this, `\d+` still shows the pre-cleanup size.
  // Verified live: 416MB -> 1.1MB for Design after this ran.
  if (!dryRun && (alreadySafe > 0 || reuploaded > 0)) {
    console.log("\nReclaiming space with VACUUM FULL (may take a moment)...");
    await prisma.$executeRawUnsafe(`VACUUM FULL "Design";`);
    const sizes: Array<{ size: string }> = await prisma.$queryRaw`
      SELECT pg_size_pretty(pg_total_relation_size('"Design"')) AS size;
    `;
    console.log(`Design table size now: ${sizes[0]?.size}`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("FAILED", err);
  process.exit(1);
});
