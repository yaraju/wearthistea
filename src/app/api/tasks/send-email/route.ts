import { NextResponse } from "next/server";
import { z } from "zod";
import { sendEmail } from "@/lib/email";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

const Body = z.object({
  to: z.string().email(),
  subject: z.string(),
  html: z.string(),
  text: z.string(),
  attachments: z
    .array(z.object({ filename: z.string(), contentBase64: z.string() }))
    .optional(),
});

// Called by Cloud Tasks, not by anything in the browser — verified by a
// shared secret (a Task's headers, not something a browser request could
// supply) rather than the sitewide Basic Auth gate, which is excluded for
// this route in middleware.ts for the same reason it's excluded for
// /api/webhooks/*: Cloud Tasks has no way to authenticate as a site user.
export async function POST(req: Request) {
  const secret = req.headers.get("x-task-secret");
  if (!process.env.TASKS_SHARED_SECRET || secret !== process.env.TASKS_SHARED_SECRET) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Malformed email task." }, { status: 400 });
  }

  try {
    await sendEmail(body);
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error("[send-email task] Failed", { to: body.to, error: err });
    // Non-2xx tells Cloud Tasks to retry per the queue's retry config.
    return NextResponse.json({ error: "Send failed." }, { status: 502 });
  }
}
