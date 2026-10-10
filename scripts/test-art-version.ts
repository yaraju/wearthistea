/**
 * Tests for issue #36 (DesignProduct.builtFromArtVersion).
 *
 * Default mode is pure/offline: tests src/lib/art-version.ts with no DB,
 * network or storage. `--live` additionally runs an integration section on
 * a scratch design (writes to the DB pointed at by DATABASE_URL, uploads to
 * storage and creates ONE Printrove product per art version; the scratch
 * design is deleted afterwards, the Printrove products are left and logged).
 * --live needs GCS_BUCKET passed explicitly on the command line, and
 * --source=<designId> (an existing design with rendered front art).
 *
 * Usage:
 *   npx tsx scripts/test-art-version.ts
 *   GCS_BUCKET=... npx tsx scripts/test-art-version.ts --live --source=<designId> [--category=men]
 * Exits non-zero if any assertion fails.
 */
import dotenv from "dotenv";
dotenv.config();

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  [${ok ? "ok" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function pure() {
  const { artVersion, isDesignProductStale, isUploadReusable, DESIGN_PRODUCT_RESET } = await import(
    "../src/lib/art-version"
  );
  console.log("Pure logic:");

  const a = { designImagePath: "/generated/b/d-1-design.png", backDesignImagePath: "/generated/b/d-1-back.png" };
  check("artVersion is stable", artVersion(a) === artVersion({ ...a }));
  check("front path change changes version", artVersion(a) !== artVersion({ ...a, designImagePath: "/generated/b/d-2-design.png" }));
  check("back path change changes version", artVersion(a) !== artVersion({ ...a, backDesignImagePath: "/generated/b/d-2-back.png" }));
  check("no back art still versions", artVersion({ ...a, backDesignImagePath: null }) !== artVersion(a));
  check("null back and front-only don't collide with a back-having design",
    artVersion({ designImagePath: "x", backDesignImagePath: null }) !== artVersion({ designImagePath: "x", backDesignImagePath: "y" }));

  check("matching version is fresh", !isDesignProductStale({ builtFromArtVersion: artVersion(a) }, artVersion(a)));
  check("different version is stale", isDesignProductStale({ builtFromArtVersion: "old|old" }, artVersion(a)));
  check("legacy null version is stale", isDesignProductStale({ builtFromArtVersion: null }, artVersion(a)));

  check("upload reusable when path matches", isUploadReusable("123", "/p.png", "/p.png"));
  check("upload not reusable when art path changed", !isUploadReusable("123", "/p.png", "/q.png"));
  check("upload not reusable when no recorded path (legacy)", !isUploadReusable("123", null, "/p.png"));
  check("upload not reusable when no id", !isUploadReusable(null, "/p.png", "/p.png"));
  check("upload not reusable when no current art", !isUploadReusable("123", "/p.png", null));

  check("reset clears product ids, mockups and version",
    DESIGN_PRODUCT_RESET.printroveProductId === null &&
      DESIGN_PRODUCT_RESET.mockupFrontUrl === null &&
      DESIGN_PRODUCT_RESET.mockupBackUrl === null &&
      DESIGN_PRODUCT_RESET.builtFromArtVersion === null &&
      DESIGN_PRODUCT_RESET.status === "pending");
}

async function live() {
  if (!process.env.GCS_BUCKET) throw new Error("--live requires GCS_BUCKET passed explicitly on the command line.");
  const source = process.argv.find((a) => a.startsWith("--source="))?.split("=")[1];
  if (!source) throw new Error("--live requires --source=<designId>.");
  const category = process.argv.find((a) => a.startsWith("--category="))?.split("=")[1] ?? "men";

  const { prisma } = await import("../src/lib/prisma");
  const { ensureDesignProduct } = await import("../src/lib/design-products");
  const { artVersion } = await import("../src/lib/art-version");
  const { readImageAsBase64, saveImageWithPreview } = await import("../src/lib/storage");
  const sharp = (await import("sharp")).default;
  console.log("\nLive (scratch design):");

  const src = await prisma.design.findUniqueOrThrow({ where: { id: source } });
  const {
    id: _id, createdAt: _c, updatedAt: _u, slug: _s, regeneratedFromDesignId: _r,
    printroveDesignId: _p1, printroveBackDesignId: _p2, printroveDesignArtPath: _p3, printroveBackDesignArtPath: _p4,
    ...rest
  } = src as Record<string, unknown> & typeof src;
  void _id; void _c; void _u; void _s; void _r; void _p1; void _p2; void _p3; void _p4;
  const scratch = await prisma.design.create({ data: { ...(rest as object), title: `SCRATCH art-version ${Date.now()}` } as never });

  try {
    const r1 = await ensureDesignProduct(scratch.id, category);
    const d1 = await prisma.design.findUniqueOrThrow({ where: { id: scratch.id } });
    check("first build stamped with current art version", r1.builtFromArtVersion === artVersion(d1), r1.status + " " + (r1.errorMessage ?? ""));
    check("first build recorded upload art path", d1.printroveDesignArtPath === d1.designImagePath);

    // Simulate a re-render without paying for one: a tinted copy of the front art at a new path.
    const original = Buffer.from(await readImageAsBase64(d1.designImagePath), "base64");
    const tinted = (await sharp(original).negate({ alpha: false }).png().toBuffer()).toString("base64");
    const saved = await saveImageWithPreview(d1.batchId, `${scratch.id}-scratch-${Date.now()}-design.png`, tinted);
    await prisma.design.update({
      where: { id: scratch.id },
      data: { designImagePath: saved.path, designPreviewImagePath: saved.previewPath },
    });

    const r2 = await ensureDesignProduct(scratch.id, category);
    const d2 = await prisma.design.findUniqueOrThrow({ where: { id: scratch.id } });
    check("art change -> new builtFromArtVersion", r2.builtFromArtVersion === artVersion(d2) && r2.builtFromArtVersion !== r1.builtFromArtVersion);
    check("art change -> new Printrove product", !!r2.printroveProductId && r2.printroveProductId !== r1.printroveProductId);
    check("art change -> new Printrove design id", !!d2.printroveDesignId && d2.printroveDesignId !== d1.printroveDesignId);
    check("art change -> upload path re-recorded", d2.printroveDesignArtPath === saved.path);
    check("art change -> mockup URL differs (or still pending)", !r2.mockupFrontUrl || r2.mockupFrontUrl !== r1.mockupFrontUrl,
      `before=${r1.mockupFrontUrl} after=${r2.mockupFrontUrl}`);
    console.log(`  Printrove products created (left on account): ${r1.printroveProductId}, ${r2.printroveProductId}`);
  } finally {
    await prisma.design.delete({ where: { id: scratch.id } });
    console.log("  scratch design deleted");
    await prisma.$disconnect();
  }
}

async function main() {
  await pure();
  if (process.argv.includes("--live")) await live();
  console.log(failures ? `\n${failures} FAILED` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
