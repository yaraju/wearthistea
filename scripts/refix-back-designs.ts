/**
 * One-time fix: back-print artwork rendered before the ink-color bug fix
 * (back-design.ts) baked in literal-black text, which is invisible on a
 * black garment (the only color in use today). Re-renders the back print
 * for every design that already has one, using the now-fixed
 * renderBackDesignArtwork, and resets printroveBackDesignId so the next
 * PrintRove touch re-uploads the corrected art instead of reusing the old
 * (wrong) asset — see the field's schema comment for why that reset is safe.
 * No LLM call: this is deterministic Satori + QR compositing, so it's cheap
 * to just redo for every affected row.
 *
 * Usage: npx tsx scripts/refix-back-designs.ts
 */
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { renderBackDesignArtwork } = await import("../src/lib/back-design");
  const { saveImageWithPreview } = await import("../src/lib/storage");
  const { settings } = await import("../src/config/settings");
  type BackLayout = "upper-back" | "full-panel" | "chest-height";

  const designs = await prisma.design.findMany({
    where: { backPhrase: { not: null } },
    select: {
      id: true,
      title: true,
      batchId: true,
      backPhrase: true,
      backLayout: true,
      variantColor: true,
      printroveBackDesignId: true,
    },
  });

  console.log(`Found ${designs.length} designs with existing back art to re-render.`);

  let fixed = 0;
  for (const d of designs) {
    try {
      const backB64 = await renderBackDesignArtwork(d.backPhrase as string, {
        layout: (d.backLayout as BackLayout) || "upper-back",
        color: d.variantColor || settings.printify.defaultColor,
      });
      const saved = await saveImageWithPreview(d.batchId, `${d.id}-back-fixed.png`, backB64);
      await prisma.design.update({
        where: { id: d.id },
        data: {
          backDesignImagePath: saved.path,
          backDesignPreviewImagePath: saved.previewPath,
          printroveBackDesignId: d.printroveBackDesignId ? null : undefined,
        },
      });
      fixed++;
      console.log(`  fixed ${d.id} (${d.title})`);
    } catch (err) {
      console.error(`  FAILED ${d.id} (${d.title}):`, err);
    }
  }

  console.log(JSON.stringify({ total: designs.length, fixed }, null, 2));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("ERROR", e);
  process.exitCode = 1;
});
