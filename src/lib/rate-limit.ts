import { randomUUID } from "crypto";
import type { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { settings } from "@/config/settings";

// Free generation is unauthenticated on purpose (Phase 6 skips anonymous
// Firebase auth — see AGENTS.md / the plan), so this cookie + the caller's
// IP are the only things standing between a stranger with the URL and the
// Gemini budget in production — Basic Auth was deliberately turned off in
// prod (Razorpay onboarding needs the site reachable). Soft guard, not a
// security boundary — see incrementAndCheck.
//
// KNOWN LIMITATION: Firebase Hosting's CDN only forwards a cookie literally
// named "__session" through to Cloud Run (see src/lib/auth.ts's
// SESSION_COOKIE, which already claims that name for the admin session) —
// any other cookie name, this one included, never makes it back on the next
// request for real browser traffic through wearthistea.web.app. So in
// practice the session axis below is always "new" in production and the IP
// axis is what's actually doing the work. Not worth unifying into one
// shared __session cookie for this — it's a soft guard either way, and
// mixing an opaque rate-limit id into the same cookie as a Firebase-issued
// session JWT is more complexity than the gain justifies.
export const RATE_LIMIT_COOKIE = "wt_sid";

function currentWindowStart(windowMs: number): number {
  return Math.floor(Date.now() / windowMs) * windowMs;
}

function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

function getClientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

/**
 * Fixed-window counter: reports whether `key`'s bucket is still under `limit`
 * for the current window, without incrementing it. Read-only — the actual
 * increment happens later via `recordGenerateUsage`, once the caller knows a
 * paid call actually went through. A race between the peek here and the
 * later increment just lets a couple of extra requests through a window
 * rather than bypassing the guard entirely, and the real gate in production
 * is still Basic Auth (proxy.ts).
 */
async function isUnderLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
  const windowStart = currentWindowStart(windowMs);
  const bucketKey = `${key}:${windowStart}`;
  const existing = await prisma.cache.findUnique({ where: { key: bucketKey } });
  const count = existing ? (JSON.parse(existing.value).count as number) : 0;
  return count < limit;
}

async function increment(key: string, windowMs: number): Promise<void> {
  const windowStart = currentWindowStart(windowMs);
  const bucketKey = `${key}:${windowStart}`;
  const expiresAt = new Date(windowStart + windowMs);

  const existing = await prisma.cache.findUnique({ where: { key: bucketKey } });
  const count = existing ? (JSON.parse(existing.value).count as number) : 0;

  await prisma.cache.upsert({
    where: { key: bucketKey },
    create: { key: bucketKey, value: JSON.stringify({ count: 1 }), expiresAt },
    update: { value: JSON.stringify({ count: count + 1 }), expiresAt },
  });
}

export interface RateLimitResult {
  ok: boolean;
  sessionId: string;
  isNewSession: boolean;
  ip: string;
}

export async function checkGenerateRateLimit(req: Request): Promise<RateLimitResult> {
  const { windowMs, maxPerSession, maxPerIp } = settings.rateLimit;

  const cookieSessionId = getCookie(req, RATE_LIMIT_COOKIE);
  const isNewSession = !cookieSessionId;
  const sessionId = cookieSessionId ?? randomUUID();
  const ip = getClientIp(req);

  const [sessionOk, ipOk] = await Promise.all([
    isUnderLimit(`ratelimit:generate:session:${sessionId}`, maxPerSession, windowMs),
    isUnderLimit(`ratelimit:generate:ip:${ip}`, maxPerIp, windowMs),
  ]);

  return { ok: sessionOk && ipOk, sessionId, isNewSession, ip };
}

/**
 * Actually spend one unit of the caller's free-generation budget. Call this
 * only once the underlying Gemini call is known to have gone through (or
 * failed for a reason that's on the caller, not on us) — never for a
 * provider-side 429/503 (Gemini's own quota/capacity, not ours), since that
 * failure isn't the caller's fault and shouldn't cost them a try.
 */
export async function recordGenerateUsage(result: RateLimitResult): Promise<void> {
  const { windowMs } = settings.rateLimit;
  await Promise.all([
    increment(`ratelimit:generate:session:${result.sessionId}`, windowMs),
    increment(`ratelimit:generate:ip:${result.ip}`, windowMs),
  ]);
}

/** Attach the rate-limit session cookie to a response when it's freshly issued. */
export function setRateLimitCookie(res: NextResponse, result: RateLimitResult) {
  if (!result.isNewSession) return;
  res.cookies.set(RATE_LIMIT_COOKIE, result.sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
    path: "/",
  });
}
