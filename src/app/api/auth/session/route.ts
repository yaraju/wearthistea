import { NextResponse } from "next/server";
import { z } from "zod";
import { createSessionCookie, verifyIdToken, isAdminToken, SESSION_COOKIE, SESSION_MAX_AGE_MS } from "@/lib/auth";

export const runtime = "nodejs";

const Body = z.object({ idToken: z.string().min(1) });

// Called right after the client completes Firebase sign-in (Google, for
// admin). Exchanges the short-lived ID token for an httpOnly session
// cookie — the client SDK's own persistence lives in IndexedDB/localStorage,
// which server routes and the admin page's initial load can't read.
export async function POST(req: Request) {
  let idToken: string;
  try {
    idToken = Body.parse(await req.json()).idToken;
  } catch {
    return NextResponse.json({ error: "idToken is required." }, { status: 400 });
  }

  try {
    const decoded = await verifyIdToken(idToken);
    if (!isAdminToken(decoded)) {
      return NextResponse.json(
        { error: "This Google account isn't an admin on wearthistea." },
        { status: 403 }
      );
    }

    const sessionCookie = await createSessionCookie(idToken);
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
