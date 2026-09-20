import { NextResponse } from "next/server";
import { sweepStuckValidations } from "@/lib/validation-sweeper";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 60;

// Called on a schedule by Cloud Scheduler (see deploy.yml's "Ensure stuck-row
// sweeper schedule" step) — same shared-secret auth as every /api/tasks/*
// route. Resolves designs stranded in validationStatus
// pending|validating|regenerating (issue #33); see
// src/lib/validation-sweeper.ts for the policy.
export async function POST(req: Request) {
  const secret = req.headers.get("x-task-secret");
  if (!process.env.TASKS_SHARED_SECRET || secret !== process.env.TASKS_SHARED_SECRET) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const result = await sweepStuckValidations();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sweep failed.";
    logger.error(`[sweep-stuck-validation] ${message}`, { error: err });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
