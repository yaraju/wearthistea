import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getProvider } from "@/lib/print-provider";

export const runtime = "nodejs";

/**
 * Poll (or restore) a batch's current state. Rendering now happens
 * server-side (see /api/tasks/render-design) the moment /api/generate
 * writes the batch, so the client no longer drives generation itself — it
 * just calls this on an interval until every design reaches a terminal
 * status, and calls it once on mount to restore a brew that was still in
 * flight (or freshly finished) the last time this browser closed the tab.
 *
 * Same response shape as POST /api/generate (batchId/keyword/designs/
 * options) so the client can treat a restore and a fresh brew identically.
 *
 * Each design's `validationStatus` (issue #11's judge/fix lifecycle) rides
 * along here same as any other plain column — KeywordStudio.tsx's
 * pollBatchStatus() polls until every design's `status` AND
 * `validationStatus` are both terminal (see shouldStopPolling() in
 * src/lib/validation-status.ts) and shows a badge while validation is in
 * flight (issue #16).
 */
export async function GET(req: Request) {
  const batchId = new URL(req.url).searchParams.get("batchId");
  if (!batchId) {
    return NextResponse.json({ error: "Missing batchId." }, { status: 400 });
  }

  const batch = await prisma.batch.findUnique({ where: { id: batchId } });
  if (!batch) {
    return NextResponse.json({ error: "Batch not found." }, { status: 404 });
  }

  const designs = await prisma.design.findMany({
    where: { batchId },
    orderBy: { id: "asc" },
  });

  // Never send full-res print files to a customer-facing caller — only the
  // downscaled previews (same stripping /api/generate/retry and
  // /api/designs/[id] already do). Also strips validationNotes — the
  // judge/fix loop's last verdict/issues text, which schema.prisma's
  // comment on that column calls "for debugging and admin visibility only",
  // not customer-facing (validationStatus itself, driving issue #16's
  // badge, is fine to send and stays in `safe`).
  const safeDesigns = designs.map((d) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { designImagePath, productImagePath, designImageData, backDesignImagePath, validationNotes, ...safe } = d;
    return safe;
  });

  const category = designs[0]?.category ?? "men";

  return NextResponse.json({
    batchId: batch.id,
    keyword: batch.keyword,
    designs: safeDesigns,
    options: getProvider().options(category),
  });
}
