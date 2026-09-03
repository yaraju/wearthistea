import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Shared-secret gate (HTTP Basic Auth).
//
// When BOTH BASIC_AUTH_USER and BASIC_AUTH_PASSWORD are set, the whole app is
// protected — the browser shows a password prompt on first visit, then sends the
// credentials with every page, API call, and image request automatically. This
// stops strangers who find the URL from spending your Gemini / Printify budget.
//
// Leave the vars unset for open local dev. Set both in production to turn it on.
//
// Note: this is a lightweight gate, not a full auth system. If you later want a
// public marketing page, swap this for a cookie-based unlock on the paid routes.
const USER = process.env.BASIC_AUTH_USER;
const PASSWORD = process.env.BASIC_AUTH_PASSWORD;

function unauthorized() {
  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="wearthistea", charset="UTF-8"' },
  });
}

export function middleware(request: NextRequest) {
  // Gate disabled unless both credentials are configured.
  if (!USER || !PASSWORD) return NextResponse.next();

  const header = request.headers.get("authorization");
  if (header?.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    const user = decoded.slice(0, sep);
    const pass = decoded.slice(sep + 1);
    if (user === USER && pass === PASSWORD) return NextResponse.next();
  }

  return unauthorized();
}

export const config = {
  // Gate everything except: Next internals, the favicon, the health check
  // (liveness probes to /api/health must never be blocked), the legal
  // pages (policies should stay publicly reachable for compliance / payment
  // processors even when the rest of the site is behind the gate), and
  // webhook endpoints — Razorpay's servers call these directly and have no
  // way to supply our Basic Auth credentials, so gating them would make
  // every webhook delivery fail with 401 before it ever reaches our
  // signature check.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/health|terms|privacy|refunds|cookies|contact|api/webhooks).*)",
  ],
};
