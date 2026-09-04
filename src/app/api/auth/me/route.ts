import { NextResponse } from "next/server";
import { getAdminSession } from "@/lib/auth";

export const runtime = "nodejs";

// Used by the admin page's client-side gate to decide whether to show the
// sign-in form or the approval queue. Only ever reports admin status — this
// isn't a general "who's logged in" endpoint; for a signed-in customer
// (Google or email-link, same __session cookie) see GET /api/account/me.
export async function GET(req: Request) {
  const session = await getAdminSession(req);
  return NextResponse.json({ isAdmin: Boolean(session), email: session?.email ?? null });
}
