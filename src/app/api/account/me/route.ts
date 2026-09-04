import { NextResponse } from "next/server";
import { getCustomerSession } from "@/lib/auth";

export const runtime = "nodejs";

// General "who's signed in" endpoint for the customer-facing UI (checkout,
// /account) — any valid session, Google or email-link, unlike
// /api/auth/me which only ever reports admin status.
export async function GET(req: Request) {
  const session = await getCustomerSession(req);
  return NextResponse.json({
    signedIn: Boolean(session),
    email: session?.email ?? null,
    uid: session?.uid ?? null,
  });
}
