import { NextResponse } from "next/server";
import { z } from "zod";
import { generateEmailSignInLink } from "@/lib/auth";
import { magicLinkEmail } from "@/lib/email";
import { enqueueEmail } from "@/lib/tasks";
import { checkAndIncrementIpLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

const Body = z.object({ email: z.string().trim().email().max(160) });

// Customer email-link sign-in, step 1: generate the link server-side (Admin
// SDK) and send it through our own branded email pipeline rather than
// letting the client SDK trigger Firebase's default email — see
// generateEmailSignInLink's doc comment. Step 2 is
// src/app/auth/verify/page.tsx, where the customer actually lands.
export async function POST(req: Request) {
  let email: string;
  try {
    email = Body.parse(await req.json()).email;
  } catch {
    return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
  }

  // 5 sends per IP per 15 minutes — a soft guard against using this to spam
  // an arbitrary inbox or burn SendGrid quota, not a security boundary.
  const ok = await checkAndIncrementIpLimit(req, "magic-link", 5, 15 * 60 * 1000);
  if (!ok) {
    return NextResponse.json(
      { error: "Too many sign-in requests — try again in a few minutes." },
      { status: 429 }
    );
  }

  try {
    const link = await generateEmailSignInLink(email);
    await enqueueEmail({ to: email, ...magicLinkEmail({ link }) });
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error("[magic-link] Failed to generate/send", { email, error: err });
    return NextResponse.json(
      { error: "Could not send the sign-in link — try again." },
      { status: 502 }
    );
  }
}
