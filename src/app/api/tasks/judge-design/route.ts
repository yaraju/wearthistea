import { NextResponse } from "next/server";
import { z } from "zod";
import { runJudgeStep } from "@/lib/validation-chain";
import { enqueueDesignFix, enqueueDesignRegenerate } from "@/lib/tasks";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 180;

const Body = z.object({
  designId: z.string().min(1),
});

// Called by Cloud Tasks (enqueueDesignJudge — see /api/tasks/render-design,
// /api/tasks/fix-design, /api/tasks/regenerate-design, all of which enqueue
// here once their own step finishes) — same shared-secret auth as every
// other /api/tasks/* route. Delegates to src/lib/validation-chain.ts's
// runJudgeStep() for the actual state machine (issue #13); this route is
// just auth + payload parsing + routing the resulting action to the next
// queue.
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

  try {
    const action = await runJudgeStep(designId);

    if (action.type === "enqueue-fix") {
      await enqueueDesignFix(designId, action.verdict);
    } else if (action.type === "enqueue-regenerate") {
      await enqueueDesignRegenerate(designId, action.verdict);
    }

    return NextResponse.json({ ok: true, action: action.type });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Judge task failed.";
    logger.error(`[judge-design task] Failed for design ${designId}: ${message}`, { designId, error: err });
    // 5xx so Cloud Tasks retries per the judge queue's own backoff config —
    // a transient Gemini error shouldn't strand the design at "validating"
    // forever with nothing to redrive it (runJudgeStep's claim() allows a
    // retry to re-claim from "validating" for exactly this reason — see
    // validation-chain.ts's top doc comment).
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
