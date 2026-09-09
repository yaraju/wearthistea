import { prisma } from "@/lib/prisma";
import { getCustomerSession, isAdminToken } from "@/lib/auth";
import { ANON_ID_HEADER } from "@/lib/anon-id";

// Anonymous callers no longer get a rate-limit cookie: Firebase Hosting's
// CDN only forwards a cookie literally named "__session" (already claimed
// by the Firebase auth session — see SESSION_COOKIE in auth.ts) through to
// Cloud Run, so any other cookie name never round-trips for real browser
// traffic through wearthistea.web.app. Anonymous identity instead comes from
// the ANON_ID_HEADER request header, set by the client from a UUID it keeps
// in localStorage (see src/lib/anon-id.ts) — headers aren't stripped by
// Hosting's rewrite the way non-"__session" cookies are.

// Used whenever the RateLimitConfig singleton row doesn't exist yet (fresh
// DB, or the admin has never saved). Exported so the admin GET route can
// show the same numbers it would actually enforce, rather than a second,
// possibly-drifted copy.
export const DEFAULT_RATE_LIMIT_CONFIG = {
  windowMs: 60 * 60 * 1000,
  maxAnonymous: 10,
  maxSignedIn: 25,
  maxAdmin: 1000,
};

function currentWindowStart(windowMs: number): number {
  return Math.floor(Date.now() / windowMs) * windowMs;
}

/**
 * Generic fixed-window counter backed by the existing Cache table (already
 * used as a general-purpose KV store elsewhere — see prisma/schema.prisma).
 * Soft guard, not a security boundary: a race between the peek here and the
 * later increment just lets a couple of extra requests through a window
 * rather than bypassing the guard entirely.
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

function getClientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

/**
 * Generic IP-keyed windowed counter, for endpoints outside the image-
 * generation family that still need a cheap abuse guard (e.g. magic-link
 * sends, which cost an outbound email each and could otherwise be used to
 * spam an arbitrary inbox). Unrelated to the auth-aware generate limits
 * below — deliberately left IP-based.
 */
export async function checkAndIncrementIpLimit(
  req: Request,
  bucket: string,
  limit: number,
  windowMs: number
): Promise<boolean> {
  const key = `ratelimit:${bucket}:ip:${getClientIp(req)}`;
  const ok = await isUnderLimit(key, limit, windowMs);
  if (ok) await increment(key, windowMs);
  return ok;
}

// ── Live-editable tier config (RateLimitConfig + RateLimitOverride) ────────

interface RateLimitSettings {
  config: typeof DEFAULT_RATE_LIMIT_CONFIG;
  overridesByEmail: Map<string, number>;
}

const SETTINGS_CACHE_TTL_MS = 15 * 1000;
let settingsCache: { value: RateLimitSettings; expiresAt: number } | null = null;

async function loadRateLimitSettings(): Promise<RateLimitSettings> {
  const [configRow, overrideRows] = await Promise.all([
    prisma.rateLimitConfig.findUnique({ where: { id: "singleton" } }),
    prisma.rateLimitOverride.findMany(),
  ]);

  const config = configRow
    ? {
        windowMs: configRow.windowMs,
        maxAnonymous: configRow.maxAnonymous,
        maxSignedIn: configRow.maxSignedIn,
        maxAdmin: configRow.maxAdmin,
      }
    : DEFAULT_RATE_LIMIT_CONFIG;

  const overridesByEmail = new Map(
    overrideRows.map((o) => [o.email.toLowerCase(), o.maxPerWindow])
  );

  return { config, overridesByEmail };
}

/** Cached (~15s) read of the live rate-limit config + per-email overrides. */
export async function getRateLimitSettings(): Promise<RateLimitSettings> {
  if (settingsCache && settingsCache.expiresAt > Date.now()) return settingsCache.value;
  const value = await loadRateLimitSettings();
  settingsCache = { value, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS };
  return value;
}

/** Call after any admin write to RateLimitConfig/RateLimitOverride. */
export function invalidateRateLimitSettingsCache(): void {
  settingsCache = null;
}

// ── Auth-aware generate/retry/realize rate limiting ─────────────────────────

export type RateLimitTier = "anonymous" | "signedIn" | "admin";

export interface RateLimitResult {
  ok: boolean;
  tier: RateLimitTier;
  bucketKey: string;
  windowMs: number;
}

function anonIdFromRequest(req: Request): string {
  const header = req.headers.get(ANON_ID_HEADER);
  if (header && header.trim()) return `session:${header.trim().slice(0, 128)}`;
  // Every real browser hitting this app sends the header (KeywordStudio
  // attaches it to every generate/retry call) — its absence means a caller
  // that skipped the client entirely (curl, a script). Falling back to a
  // brand-new random id per request would make that path completely
  // unlimited, which is a worse guard than the IP+cookie combo this
  // replaced. IP is a degenerate-case fallback here, not a general
  // anonymous-tier axis — real visitors are still limited purely by session.
  return `ip:${getClientIp(req)}`;
}

/**
 * Resolve who's calling and which bucket/limit applies, without deciding
 * ok/not yet spending the caller's budget (see recordGenerateUsage). Reads
 * the __session cookie via getCustomerSession at most once — isAdminToken
 * is checked against the same decoded token rather than re-verifying.
 */
export async function checkGenerateRateLimit(req: Request): Promise<RateLimitResult> {
  const { config, overridesByEmail } = await getRateLimitSettings();
  const decoded = await getCustomerSession(req);

  if (decoded && isAdminToken(decoded)) {
    const bucketKey = "ratelimit:generate:admin";
    const ok = await isUnderLimit(bucketKey, config.maxAdmin, config.windowMs);
    return { ok, tier: "admin", bucketKey, windowMs: config.windowMs };
  }

  if (decoded) {
    const override = decoded.email ? overridesByEmail.get(decoded.email.toLowerCase()) : undefined;
    const limit = override ?? config.maxSignedIn;
    const bucketKey = `ratelimit:generate:user:${decoded.uid}`;
    const ok = await isUnderLimit(bucketKey, limit, config.windowMs);
    return { ok, tier: "signedIn", bucketKey, windowMs: config.windowMs };
  }

  const anonId = anonIdFromRequest(req);
  const bucketKey = `ratelimit:generate:anon:${anonId}`;
  const ok = await isUnderLimit(bucketKey, config.maxAnonymous, config.windowMs);
  return { ok, tier: "anonymous", bucketKey, windowMs: config.windowMs };
}

/**
 * Actually spend one unit of the caller's free-generation budget. Call this
 * only once the underlying Gemini call is known to have gone through (or
 * failed for a reason that's on the caller, not on us) — never for a
 * provider-side 429/503 (Gemini's own quota/capacity, not ours), since that
 * failure isn't the caller's fault and shouldn't cost them a try.
 */
export async function recordGenerateUsage(result: RateLimitResult): Promise<void> {
  await increment(result.bucketKey, result.windowMs);
}
