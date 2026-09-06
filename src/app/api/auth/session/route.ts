import { NextResponse } from "next/server";
import { z } from "zod";
import { createSessionCookie, verifyIdToken, ensureUserRecord, SESSION_COOKIE, SESSION_MAX_AGE_MS } from "@/lib/auth";

export const runtime = "nodejs";

const Body = z.object({ idToken: z.string().min(1) });

// Called right after the client completes Firebase sign-in — Google (admin
// or customer) or email-link (customer only, enforced client-side; nothing
// stops a customer from also using Google). Exchanges the short-lived ID
// token for an httpOnly session cookie — the client SDK's own persistence
// lives in IndexedDB/localStorage, which server routes and page initial
// loads can't read.
//
// Deliberately does NOT check isAdminToken here — any valid Firebase user
// gets a session cookie; admin-ness is re-checked independently on every
// /api/admin/* request via requireAdmin/getAdminSession. Mixing that check
// into cookie-minting would block ordinary customers from ever signing in.
export async function POST(req: Request) {
  let idToken: string;
  try {
    idToken = Body.parse(await req.json()).idToken;
  } catch {
    return NextResponse.json({ error: "idToken is required." }, { status: 400 });
  }

  try {
    const decoded = await verifyIdToken(idToken);
    const sessionCookie = await createSessionCookie(idToken);
    await ensureUserRecord(decoded);

    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, sessionCookie, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_MS / 1000,
    });
    return res;
  } catch {
    return NextResponse.json(
      { error: "Sign-in failed — the link may have expired. Try again." },
      { status: 401 }
    );
  }
}
