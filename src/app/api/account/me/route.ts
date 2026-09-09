import { NextResponse } from "next/server";
import { getCustomerSession, isAdminToken } from "@/lib/auth";

export const runtime = "nodejs";

// General "who's signed in" endpoint for the customer-facing UI (checkout,
// /account, the header profile menu) — any valid session, Google or
// email-link, unlike /api/auth/me which only ever reports admin status.
// isAdmin is derived from the SAME already-decoded session token (no extra
// Firebase Admin call) — an admin is also a valid customer session, so this
// lets the header show the Admin pill without a second round-trip.
export async function GET(req: Request) {
  const session = await getCustomerSession(req);
  return NextResponse.json({
    signedIn: Boolean(session),
    email: session?.email ?? null,
    uid: session?.uid ?? null,
    authProvider: session?.firebase?.sign_in_provider ?? null,
    isAdmin: session ? isAdminToken(session) : false,
  });
}
