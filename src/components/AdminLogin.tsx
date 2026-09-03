"use client";

import { useEffect, useState } from "react";
import {
  isSignInWithEmailLink,
  sendSignInLinkToEmail,
  signInWithEmailLink,
} from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebase-client";

const STORAGE_KEY = "wt_admin_pending_email";

/**
 * Magic-link sign-in gate for /admin. Only meaningful account here is
 * yaraju@gmail.com (enforced server-side in src/lib/auth.ts) — this is just
 * the UI to get a Firebase session cookie set so /api/admin/* stops 401ing.
 */
export default function AdminLogin({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const auth = getFirebaseAuth();
    if (!isSignInWithEmailLink(auth, window.location.href)) return;

    const storedEmail = window.localStorage.getItem(STORAGE_KEY);
    const finish = async (emailToUse: string) => {
      setCompleting(true);
      setError(null);
      try {
        const cred = await signInWithEmailLink(auth, emailToUse, window.location.href);
        const idToken = await cred.user.getIdToken();
        const res = await fetch("/api/auth/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Sign-in failed.");
        window.localStorage.removeItem(STORAGE_KEY);
        window.history.replaceState({}, "", window.location.pathname);
        onSignedIn();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Sign-in failed.");
      } finally {
        setCompleting(false);
      }
    };

    if (storedEmail) {
      finish(storedEmail);
    } else {
      // Link opened on a different device/browser than it was requested
      // from — ask once rather than silently failing.
      const typed = window.prompt("Confirm the email you signed in with:");
      if (typed) finish(typed.trim());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function sendLink(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const auth = getFirebaseAuth();
      await sendSignInLinkToEmail(auth, email.trim(), {
        url: `${window.location.origin}/admin`,
        handleCodeInApp: true,
      });
      window.localStorage.setItem(STORAGE_KEY, email.trim());
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the sign-in link.");
    }
  }

  if (completing) {
    return <div className="p-8 text-center text-sm text-neutral-500">Signing you in…</div>;
  }

  return (
    <div className="mx-auto mt-24 max-w-sm p-6">
      <h1 className="mb-4 text-lg font-semibold">Admin sign-in</h1>
      {sent ? (
        <p className="text-sm text-neutral-600">
          Check {email} for a sign-in link, then open it on this device.
        </p>
      ) : (
        <form onSubmit={sendLink} className="flex flex-col gap-3">
          <input
            type="email"
            required
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded border border-neutral-300 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            className="rounded bg-black px-3 py-2 text-sm text-white"
          >
            Send sign-in link
          </button>
        </form>
      )}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </div>
  );
}
