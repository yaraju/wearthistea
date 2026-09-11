import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { settings } from "@/config/settings";
import { saveImageWithPreview } from "@/lib/storage";
import { renderBackDesignArtwork, type BackLayout } from "@/lib/back-design";

export const runtime = "nodejs";
export const maxDuration = 120;

const Body = z.object({
  backLayout: z.enum(["upper-back", "full-panel", "chest-height"]),
});

/**
 * Flip a design's back-print A/B/C layout and re-render its back art in
 * place. Meant for pre-order experimentation, not for a design with live
 * Orders already attached — flipping resets every DesignProduct row for
 * this design so PrintRove rebuilds the product/mockup against the new back
 * art, and any Order already referencing one of those rows will see it
 * change out from under it. Left unguarded for this iteration.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const { id } = await ctx.params;
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "A valid backLayout is required." }, { status: 400 });
  }

  const design = await prisma.design.findUnique({ where: { id } });
  if (!design) {
    return NextResponse.json({ error: "Design not found." }, { status: 404 });
  }
  if (!design.backPhrase) {
    return NextResponse.json({ error: "This design has no back phrase to render." }, { status: 409 });
  }

  let backB64: string;
  try {
    backB64 = await renderBackDesignArtwork(design.backPhrase, {
      layout: body.backLayout as BackLayout,
      color: design.variantColor || settings.printify.defaultColor,
    });
  } catch {
    return NextResponse.json({ error: "Could not render the back design." }, { status: 500 });
  }

  const saved = await saveImageWithPreview(design.batchId, `${design.id}-back-flip-${Date.now()}.png`, backB64);

  const updated = await prisma.design.update({
    where: { id },
    data: {
      backLayout: body.backLayout,
      backDesignImagePath: saved.path,
      backDesignPreviewImagePath: saved.previewPath,
      // Art changed — force a re-upload next time PrintRove needs it.
      printroveBackDesignId: null,
    },
  });

  // Force every (category, color) product for this design to rebuild
  // against the new back art — ensureDesignProduct() recreates on next
  // poll/view once these are cleared.
  await prisma.designProduct.updateMany({
    where: { designId: id },
    data: {
      printroveProductId: null,
      printroveVariantId: null,
      mockupFrontUrl: null,
      mockupBackUrl: null,
      status: "pending",
      errorMessage: null,
    },
  });

  return NextResponse.json({ ok: true, design: updated });
}
