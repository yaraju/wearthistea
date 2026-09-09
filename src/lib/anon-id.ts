const STORAGE_KEY = "wt_anon_id";

// Kept here (not in rate-limit.ts, which pulls in server-only prisma/
// firebase-admin imports client components can't bundle) so both the
// client fetch calls and the server-side resolver agree on the header name.
export const ANON_ID_HEADER = "x-wt-anon-id";

/**
 * Stable per-browser id for the anonymous rate-limit tier — see
 * ANON_ID_HEADER in src/lib/rate-limit.ts for why this rides a header
 * instead of a cookie. Wrapped in try/catch because localStorage can throw
 * (private browsing, blocked storage): falling back to a fresh id per call
 * just means that visitor isn't usefully rate-limited, same soft-guard
 * posture the rest of this system already accepts.
 */
export function getAnonId(): string {
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}
