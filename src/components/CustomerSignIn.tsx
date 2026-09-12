"use client";

import { useState, type FormEvent } from "react";
import { GoogleAuthProvider, signInWithPopup } from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebase-client";
import { friendlyError } from "@/lib/error-messages";
import { ANON_ID_HEADER, getAnonId } from "@/lib/anon-id";

// Key the verify page reads back on this device to complete
// signInWithEmailLink without re-prompting for the address — Firebase's own
// documented pattern for its email-link flow (see auth/verify/page.tsx).
export const EMAIL_FOR_SIGN_IN_KEY = "wt_emailForSignIn";

// Matches KeywordStudio.tsx's FIELD_CLS — kept as a separate copy rather
// than a cross-file export for one shared string.
const FIELD_CLS =
  "w-full rounded-lg border border-line bg-paper px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-soft/60 focus:border-ink focus:outline-none";

/**
 * Customer sign-in, offered as a choice per the product call: Google is
 * instant (one popup, no email round-trip); email-link is slower (customer
 * has to leave the tab and click a link we send) but needs no password and
 * works for anyone without a Google account. Used at checkout and on
 * /account — same component, same session cookie either way.
 */
export default function CustomerSignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [busy, setBusy] = useState<"google" | "email" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [linkSent, setLinkSent] = useState(false);

  async function mintSession(idToken: string) {
    const res = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", [ANON_ID_HEADER]: getAnonId() },
      body: JSON.stringify({ idToken }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Sign-in failed.");
    }
  }

  async function signInWithGoogle() {
    setBusy("google");
    setError(null);
    try {
      const auth = getFirebaseAuth();
      const cred = await signInWithPopup(auth, new GoogleAuthProvider());
      const idToken = await cred.user.getIdToken();
      await mintSession(idToken);
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setBusy(null);
    }
  }

  async function sendEmailLink(e: FormEvent) {
    e.preventDefault();
    setBusy("email");
    setError(null);
    try {
      const res = await fetch("/api/auth/magic-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not send the sign-in link.");
      try {
        window.localStorage.setItem(EMAIL_FOR_SIGN_IN_KEY, email);
      } catch {
        // Private-browsing / storage blocked — verify page falls back to
        // prompting for the email, which still works.
      }
      setLinkSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the sign-in link.");
    } finally {
      setBusy(null);
    }
  }

  if (linkSent) {
    return (
      <div className="font-mono text-xs text-ink-soft">
        <p>Check <strong className="text-ink">{email}</strong> for a sign-in link.</p>
        <p className="mt-1">You can close this — the link will bring you back here signed in.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      <button
        type="button"
        onClick={signInWithGoogle}
        disabled={busy !== null}
        className="w-full rounded-lg bg-ink px-3 py-2 font-mono text-xs font-bold uppercase tracking-widest text-paper disabled:opacity-50"
      >
        {busy === "google" ? "Signing in…" : "Continue with Google"}
      </button>

      <div className="flex items-center gap-2 font-mono text-[11px] text-ink-soft">
        <span className="h-px flex-1 bg-line" />
        or
        <span className="h-px flex-1 bg-line" />
      </div>

      <form onSubmit={sendEmailLink} className="flex gap-2">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className={FIELD_CLS}
        />
        <button
          type="submit"
          disabled={busy !== null}
          className="shrink-0 rounded-lg border border-line px-3 py-2 font-mono text-xs text-ink disabled:opacity-50"
        >
          {busy === "email" ? "Sending…" : "Email me a link"}
        </button>
      </form>

      {error && <p className="font-mono text-xs text-pink-ink">{friendlyError(error)}</p>}
    </div>
  );
}
