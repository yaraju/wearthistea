import { NextResponse } from "next/server";
import { z } from "zod";
import { settings } from "@/config/settings";
import { ensureDesignProduct } from "@/lib/design-products";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({ designId: z.string().min(1) });

// Called by Cloud Tasks (enqueuePrintroveProducts, right after a design's
// artwork finishes rendering) — same shared-secret auth as
// /api/tasks/send-email, since Cloud Tasks can't authenticate as a site
// user. Creates one Printrove preview product per enabled category for this
// design, so the customer-facing pick-time modal usually finds them ready.
export async function POST(req: Request) {
  const secret = req.headers.get("x-task-secret");
  if (!process.env.TASKS_SHARED_SECRET || secret !== process.env.TASKS_SHARED_SECRET) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let designId: string;
  try {
    designId = Body.parse(await req.json()).designId;
  } catch {
    return NextResponse.json({ error: "Malformed task payload." }, { status: 400 });
  }

  const categories = settings.printrove.products.filter((p) => p.enabled).map((p) => p.category);

  const results = await Promise.all(
    categories.map(async (category) => {
      const row = await ensureDesignProduct(designId, category);
      return { category, status: row.status, errorMessage: row.errorMessage };
    })
  );

  const failed = results.filter((r) => r.status === "failed");
  if (failed.length > 0) {
    logger.error("[printrove-products task] One or more categories failed", { designId, failed });
    // Non-2xx tells Cloud Tasks to retry per the queue's retry config —
    // ensureDesignProduct is idempotent, so a retry just skips ahead past
    // whatever categories already succeeded.
    return NextResponse.json({ ok: false, results }, { status: 502 });
  }

  return NextResponse.json({ ok: true, results });
}
