import { randomUUID } from "crypto";
import type { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { settings } from "@/config/settings";

// Free generation is unauthenticated on purpose (Phase 6 skips anonymous
// Firebase auth — see AGENTS.md / the plan), so this cookie + the caller's
// IP are the only things standing between a stranger with the URL and the
// Gemini budget in production. It's a soft abuse guard sitting behind
// Basic Auth in prod, not a security boundary — see incrementAndCheck.
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
 * Fixed-window counter: increments `key`'s bucket for the current window and
 * reports whether it was still under `limit` beforehand. Read-then-write,
 * not a single atomic op — fine here since a race just lets a couple of
 * extra requests through a window rather than bypassing the guard entirely,
 * and the real gate in production is still Basic Auth (proxy.ts).
 */
async function incrementAndCheck(key: string, limit: number, windowMs: number): Promise<boolean> {
  const windowStart = currentWindowStart(windowMs);
  const bucketKey = `${key}:${windowStart}`;
  const expiresAt = new Date(windowStart + windowMs);

  const existing = await prisma.cache.findUnique({ where: { key: bucketKey } });
  const count = existing ? (JSON.parse(existing.value).count as number) : 0;
  if (count >= limit) return false;

  await prisma.cache.upsert({
    where: { key: bucketKey },
    create: { key: bucketKey, value: JSON.stringify({ count: 1 }), expiresAt },
    update: { value: JSON.stringify({ count: count + 1 }), expiresAt },
  });
  return true;
}

export interface RateLimitResult {
  ok: boolean;
  sessionId: string;
  isNewSession: boolean;
}

export async function checkGenerateRateLimit(req: Request): Promise<RateLimitResult> {
  const { windowMs, maxPerSession, maxPerIp } = settings.rateLimit;

  const cookieSessionId = getCookie(req, RATE_LIMIT_COOKIE);
  const isNewSession = !cookieSessionId;
  const sessionId = cookieSessionId ?? randomUUID();
  const ip = getClientIp(req);

  const [sessionOk, ipOk] = await Promise.all([
    incrementAndCheck(`ratelimit:generate:session:${sessionId}`, maxPerSession, windowMs),
    incrementAndCheck(`ratelimit:generate:ip:${ip}`, maxPerIp, windowMs),
  ]);

  return { ok: sessionOk && ipOk, sessionId, isNewSession };
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
