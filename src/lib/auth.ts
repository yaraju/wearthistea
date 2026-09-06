import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth, type DecodedIdToken } from "firebase-admin/auth";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

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

/**
 * Server-generated email-link sign-in URL (Admin SDK) rather than letting
 * the client SDK's sendSignInLinkToEmail trigger Firebase's own default
 * email — this way the link goes out through our existing branded
 * SendGrid/Cloud-Tasks pipeline (magicLinkEmail in lib/email.ts) like every
 * other transactional email, instead of looking like a different product.
 */
export async function generateEmailSignInLink(email: string): Promise<string> {
  const siteUrl = (process.env.SITE_URL || "http://localhost:3000").replace(/\/$/, "");
  return auth().generateSignInWithEmailLink(email, {
    url: `${siteUrl}/auth/verify`,
    handleCodeInApp: true,
  });
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

/**
 * Upsert the `User` row for a decoded session token. Called at session-mint
 * time (`/api/auth/session`) and defensively re-run here on every customer
 * request, because a session cookie outlives a single deploy: a cookie
 * minted before this upsert existed (or before a given field was added)
 * stays valid under Firebase's own check but would otherwise point at a
 * `User` row that was never created, breaking any write that references
 * `userId` (e.g. saving an address) with a foreign-key violation.
 */
export async function ensureUserRecord(decoded: DecodedIdToken): Promise<void> {
  if (!decoded.email) return;
  await prisma.user.upsert({
    where: { id: decoded.uid },
    create: {
      id: decoded.uid,
      email: decoded.email,
      emailVerified: decoded.email_verified ?? false,
      authProvider: decoded.firebase?.sign_in_provider ?? "email_link",
    },
    update: {
      email: decoded.email,
      emailVerified: decoded.email_verified ?? false,
    },
  });
}

/**
 * Decode the session cookie for a signed-in customer — any valid session,
 * Google or email-link, no ADMIN_EMAILS/provider restriction. An admin is
 * also a valid customer session on the same cookie; nothing conflicts.
 */
export async function getCustomerSession(req: Request): Promise<DecodedIdToken | null> {
  const cookie = readCookie(req, SESSION_COOKIE);
  if (!cookie) return null;
  return verifySession(cookie);
}

/** Guard for the top of every /api/account/* handler. */
export async function requireCustomer(req: Request): Promise<NextResponse | null> {
  const session = await getCustomerSession(req);
  if (!session) {
    return NextResponse.json({ error: "Sign in to do this." }, { status: 401 });
  }
  await ensureUserRecord(session);
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
