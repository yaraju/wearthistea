"use client";

import { useState } from "react";
import { GoogleAuthProvider, signInWithPopup } from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebase-client";

/**
 * Google-only sign-in gate for /admin. The only accounts that actually get
 * in are yaraju@gmail.com / wearthistea@gmail.com (enforced server-side in
 * src/lib/auth.ts, which also requires the Google provider specifically) —
 * this is just the UI to get a session cookie set so /api/admin/* stops
 * 401ing.
 */
export default function AdminLogin({ onSignedIn }: { onSignedIn: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const auth = getFirebaseAuth();
      const cred = await signInWithPopup(auth, new GoogleAuthProvider());
      const idToken = await cred.user.getIdToken();
      const res = await fetch("/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Sign-in failed.");
      }
      // /api/auth/session mints a cookie for any valid Firebase user now
      // (customers sign in too, elsewhere) — admin-ness has to be checked
      // separately here to keep this page's error message specific.
      const meRes = await fetch("/api/auth/me", { cache: "no-store" });
      const me = await meRes.json().catch(() => ({}));
      if (!me.isAdmin) {
        throw new Error("This Google account isn't an admin on wearthistea.");
      }
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto mt-24 max-w-sm p-6 text-center">
      <h1 className="mb-4 text-lg font-semibold">Admin sign-in</h1>
      <button
        onClick={signIn}
        disabled={busy}
        className="w-full rounded bg-black px-3 py-2 text-sm text-white disabled:opacity-50"
      >
        {busy ? "Signing in…" : "Sign in with Google"}
      </button>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </div>
  );
}
