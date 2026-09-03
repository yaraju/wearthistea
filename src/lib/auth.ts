import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import { NextResponse } from "next/server";

// The one account allowed into /admin and /api/admin/*. Not a general
// allowlist — this business has exactly one admin.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "yaraju@gmail.com").toLowerCase();

export const SESSION_COOKIE = "wt_session";
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

export function isAdminEmail(email?: string | null): boolean {
  return Boolean(email) && email!.toLowerCase() === ADMIN_EMAIL;
}

/** Decode + admin-check the session cookie on an incoming request, or null. */
export async function getAdminSession(req: Request): Promise<DecodedIdToken | null> {
  const cookie = readCookie(req, SESSION_COOKIE);
  if (!cookie) return null;
  const decoded = await verifySession(cookie);
  if (!decoded || !decoded.email_verified || !isAdminEmail(decoded.email)) return null;
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
