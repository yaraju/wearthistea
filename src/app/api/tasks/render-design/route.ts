import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { finalizeDesignRender } from "@/lib/design-render";
import { reevaluateRateLimit } from "@/lib/rate-limit";
import { langfuse, getTraceId } from "@/lib/langfuse";
import { logger } from "@/lib/logger";
import { enqueueDesignJudge } from "@/lib/tasks";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  designId: z.string().min(1),
  rateLimit: z.object({
    tier: z.enum(["anonymous", "signedIn", "admin"]),
    bucketKey: z.string().min(1),
    windowMs: z.number().positive(),
    limit: z.number().positive(),
  }),
});

// Called by Cloud Tasks (enqueueDesignRender, right after /api/generate
// writes a "generating" placeholder row) — same shared-secret auth as the
// other /api/tasks/* routes, since Cloud Tasks can't authenticate as a site
// user. This is now the primary way a design's artwork gets rendered — the
// browser no longer has to stay open for it (see enqueueDesignRender's doc
// comment); /api/generate/retry remains for the customer-facing manual
// "Retry Render" button on an already-failed card.
/**
 * Moves an already-rendered design into the judge chain. Claims
 * unjudged -> "pending" BEFORE enqueueing (issue #33) — the old
 * enqueue-then-unconditionally-write-"pending" order could overwrite a
 * status the judge task had already advanced (or resurrect a superseded
 * row) — and rolls the claim back if nothing was queued. Idempotent: a row
 * that isn't "unjudged" any more is left alone. Never throws: an enqueue
 * failure leaves the row "unjudged", which is a valid settled state (and a
 * redelivery of this task will simply try the hand-off again).
 */
async function handOffToJudge(designId: string) {
  try {
    const claimed = await prisma.design.updateMany({
      where: { id: designId, validationStatus: "unjudged" },
      data: { validationStatus: "pending" },
    });
    if (claimed.count === 0) return;
    let queued = false;
    try {
      queued = await enqueueDesignJudge(designId);
    } finally {
      if (!queued) {
        await prisma.design.updateMany({
          where: { id: designId, validationStatus: "pending" },
          data: { validationStatus: "unjudged" },
        });
      }
    }
    if (!queued) logger.info("[render-design task] Judge queue not configured — design left unjudged", { designId });
  } catch (err) {
    logger.error("[render-design task] Failed to hand off to judge (design left unjudged)", { designId, error: err });
  }
}

export async function POST(req: Request) {
  const secret = req.headers.get("x-task-secret");
  if (!process.env.TASKS_SHARED_SECRET || secret !== process.env.TASKS_SHARED_SECRET) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Malformed task payload." }, { status: 400 });
  }

  const { designId } = body;

  const trace = langfuse.trace({
    name: "render-design-task",
    id: getTraceId(req),
    input: { designId },
  });

  const design = await prisma.design.findUnique({ where: { id: designId } });
  if (!design) {
    // Nothing to render and nothing Cloud Tasks retrying would fix —
    // acknowledge so it doesn't redeliver.
    logger.error("[render-design task] Design not found", { designId });
    return NextResponse.json({ error: "Design not found." }, { status: 200 });
  }

  // Idempotency (issues #31/#33): a redelivered/duplicate task for a design
  // that already rendered must NOT re-render it, re-spend the rate-limit
  // bucket, overwrite status with a rate-limit "failed", or reset a
  // validationStatus the judge chain has since moved on. Only "generating"
  // (fresh) and "failed" (a transient-failure redelivery, which the row was
  // marked with as a safety net) still need rendering. For an already
  // rendered design just resume the hand-off to judge if it never happened.
  if (design.status === "generated") {
    await handOffToJudge(designId);
    return NextResponse.json({ ok: true, skipped: true });
  }

  // Re-check the caller's budget against the CURRENT live count — the
  // identity was resolved back in /api/generate, but this task may run
  // seconds to minutes later and possibly after sibling designs in the same
  // batch have already spent from the same bucket. Exactly mirrors what a
  // fresh /api/generate/retry call would do for this same design.
  const rateLimit = await reevaluateRateLimit(body.rateLimit);
  if (!rateLimit.ok) {
    // Conditional (issue #31): only a design still awaiting its render may be
    // flipped to "failed" — never one that has rendered since.
    await prisma.design
      .updateMany({
        where: { id: designId, status: { in: ["generating", "failed"] } },
        data: {
          status: "failed",
          errorMessage: "You've hit the free-generation limit for now — try again in a bit.",
        },
      })
      .catch((err) => {
        logger.error("[render-design task] Failed to persist rate-limit failure", { designId, error: err });
      });
    // Not the caller's fault to retry into the same limit — acknowledge.
    return NextResponse.json({ ok: false, error: "Rate limit exceeded." }, { status: 200 });
  }

  const result = await finalizeDesignRender(design, trace, rateLimit);

  if (!result.ok) {
    // A transient provider error (Gemini's own 429/503) gets a 5xx so Cloud
    // Tasks retries per the queue's own backoff config — finalizeDesignRender
    // already marked the row "failed" as a safety net, but a successful
    // redelivery just overwrites it back to "generated". A non-transient
    // error (bad prompt, provider outage-adjacent) is left at "failed" for
    // the customer's own "Retry Render" button instead of burning through
    // Cloud Tasks' retry budget on something that won't self-resolve.
    return NextResponse.json({ ok: false, error: result.error }, { status: result.transient ? 503 : 200 });
  }

  // Art rendered successfully — hand off to the judge chain (issue #13).
  await handOffToJudge(designId);

  return NextResponse.json({ ok: true });
}
