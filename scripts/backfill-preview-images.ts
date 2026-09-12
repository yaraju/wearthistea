/**
 * One-time migration: generate the missing downscaled preview images for
 * designs that predate the preview-image feature (d04347b) — their
 * productPreviewImagePath/designPreviewImagePath/backDesignPreviewImagePath
 * columns are null (or "" for regenerate-route siblings) even though the
 * full-res art still exists in storage.
 *
 * Skips (and reports) any design whose full-res source file is actually
 * gone from storage — those need real regeneration, not a downscale, and
 * are handled by scripts/regenerate-missing-designs.ts. This script never
 * touches designImagePath/productImagePath/backDesignImagePath, only the
 * *PreviewImagePath columns, so it can't make a working design worse.
 *
 * Usage: npx tsx scripts/backfill-preview-images.ts
 */
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { getFile, saveFile } = await import("../src/lib/storage");
  const { createPreviewImage } = await import("../src/lib/image-preview");

  function previewRelPath(fullResPublicPath: string): string {
    const rel = fullResPublicPath.replace(/^\/generated\/?/, "");
    return rel.replace(/(\.[a-z]+)$/i, "-preview$1");
  }

  // getFile() throws on both "object doesn't exist" and transient GCS/network
  // errors alike — the first run of this script (sequential, ~700 downloads,
  // no retry) misclassified a large fraction of real, present files as
  // "missing source" this way. Retry a few times before giving up so a blip
  // doesn't get treated as a permanently lost file.
  async function backfillOne(fullResPublicPath: string): Promise<string> {
    const rel = fullResPublicPath.replace(/^\/generated\/?/, "");
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { data } = await getFile(rel);
        const base64 = Buffer.from(data).toString("base64");
        const previewBase64 = await createPreviewImage(base64);
        const previewRel = previewRelPath(fullResPublicPath);
        return await saveFile(previewRel, Buffer.from(previewBase64, "base64"), "image/png");
      } catch (err) {
        lastErr = err;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  const designs = await prisma.design.findMany({
    where: {
      productImagePath: { not: "" },
      OR: [
        { productPreviewImagePath: null },
        { productPreviewImagePath: "" },
        { designPreviewImagePath: null },
        { designPreviewImagePath: "" },
        { AND: [{ backDesignImagePath: { not: null } }, { backDesignPreviewImagePath: null }] },
      ],
    },
    select: {
      id: true,
      title: true,
      productImagePath: true,
      designImagePath: true,
      backDesignImagePath: true,
      productPreviewImagePath: true,
      designPreviewImagePath: true,
      backDesignPreviewImagePath: true,
    },
  });

  console.log(`Found ${designs.length} designs needing a preview backfill.`);

  let backfilled = 0;
  let skippedMissingSource = 0;
  const missingSourceIds: string[] = [];

  for (const d of designs) {
    const data: Record<string, string> = {};

    if (!d.productPreviewImagePath) {
      try {
        data.productPreviewImagePath = await backfillOne(d.productImagePath);
      } catch {
        console.log(`  [missing source] ${d.id} (${d.title}) product image`);
        missingSourceIds.push(d.id);
      }
    }

    if (!d.designPreviewImagePath) {
      try {
        data.designPreviewImagePath = await backfillOne(d.designImagePath);
      } catch {
        console.log(`  [missing source] ${d.id} (${d.title}) design image`);
        if (!missingSourceIds.includes(d.id)) missingSourceIds.push(d.id);
      }
    }

    if (d.backDesignImagePath && !d.backDesignPreviewImagePath) {
      try {
        data.backDesignPreviewImagePath = await backfillOne(d.backDesignImagePath);
      } catch {
        console.log(`  [missing source] ${d.id} (${d.title}) back image`);
      }
    }

    if (Object.keys(data).length > 0) {
      await prisma.design.update({ where: { id: d.id }, data });
      backfilled++;
    } else {
      skippedMissingSource++;
    }
  }

  console.log(
    JSON.stringify(
      {
        totalCandidates: designs.length,
        backfilled,
        skippedMissingSource,
        missingSourceIds: [...new Set(missingSourceIds)],
      },
      null,
      2
    )
  );

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("ERROR", e);
  process.exitCode = 1;
});
