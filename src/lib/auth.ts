import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import { NextResponse } from "next/server";

// The accounts allowed into /admin and /api/admin/* — comma-separated.
// Firebase Auth is also configured for email/password and email link, but
// admin access specifically requires signing in with Google (see
// isAdminEmail below) at one of these addresses.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "yaraju@gmail.com,wearthistea@gmail.com")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

// MUST be named exactly "__session" — Firebase Hosting's CDN strips every
// cookie except one with this exact name before forwarding a request to
// Cloud Run (undocumented-in-code but well-known Hosting behavior: it's the
// one cookie name allowlisted through the rewrite proxy, precisely so
// backends behind Hosting can keep a session). Any other name round-trips
// fine in a request that skips Hosting (e.g. curl straight to the Cloud Run
// URL, or local dev) but silently vanishes for real browser traffic through
// wearthistea.web.app — which is exactly the bug this was.
export const SESSION_COOKIE = "__session";
// Firebase's own hard cap on session cookie lifetime.
export const SESSION_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000;

function adminApp() {
  const apps = getApps();
  if (apps.length) return apps[0];
  // No explicit credentials: Application Default Credentials — Cloud Run's
  // attached service account in production, `gcloud auth application-default
  // login` (or GOOGLE_APPLICATION_CREDENTIALS) locally. Same pattern already
  // used for @google-cloud/tasks and @google-cloud/storage in this repo.
  return initializeApp();
}

function auth() {
  return getAuth(adminApp());
}

/** Decode + verify a freshly-signed-in client ID token (not a session cookie). */
export async function verifyIdToken(idToken: string): Promise<DecodedIdToken> {
  return auth().verifyIdToken(idToken);
}

/** Exchange a freshly-signed-in client ID token for a long-lived session cookie. */
export async function createSessionCookie(idToken: string): Promise<string> {
  return auth().createSessionCookie(idToken, { expiresIn: SESSION_MAX_AGE_MS });
}

/** Verify a session cookie value, checking Firebase's revocation list too. */
export async function verifySession(sessionCookie: string): Promise<DecodedIdToken | null> {
  try {
    return await auth().verifySessionCookie(sessionCookie, true);
  } catch {
    return null;
  }
}

function isAllowedAdminEmail(email?: string | null): boolean {
  return Boolean(email) && ADMIN_EMAILS.includes(email!.toLowerCase());
}

/**
 * Admin sign-in must be via Google specifically (not the email/password or
 * email-link methods also enabled on this Firebase project) — the user's
 * explicit call, since only they control those two Google accounts.
 */
function signedInWithGoogle(decoded: DecodedIdToken): boolean {
  return decoded.firebase?.sign_in_provider === "google.com";
}

export function isAdminToken(decoded: DecodedIdToken): boolean {
  return Boolean(decoded.email_verified) && isAllowedAdminEmail(decoded.email) && signedInWithGoogle(decoded);
}

/** Decode + admin-check the session cookie on an incoming request, or null. */
export async function getAdminSession(req: Request): Promise<DecodedIdToken | null> {
  const cookie = readCookie(req, SESSION_COOKIE);
  if (!cookie) return null;
  const decoded = await verifySession(cookie);
  if (!decoded || !isAdminToken(decoded)) return null;
  return decoded;
}

/** Guard for the top of every /api/admin/* handler. */
export async function requireAdmin(req: Request): Promise<NextResponse | null> {
  const session = await getAdminSession(req);
  if (!session) {
    return NextResponse.json(
      { error: "Sign in as the admin account to do this." },
      { status: 401 }
    );
  }
  return null;
}

function readCookie(req: Request, name: string): string | undefined {
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
