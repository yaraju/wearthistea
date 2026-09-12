"use client";

import { useEffect, useState } from "react";
import { isSignInWithEmailLink, signInWithEmailLink } from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebase-client";
import { EMAIL_FOR_SIGN_IN_KEY } from "@/components/CustomerSignIn";
import { ANON_ID_HEADER, getAnonId } from "@/lib/anon-id";

type Status = "checking" | "needs-email" | "verifying" | "done" | "error";

// Where the customer lands after clicking the emailed sign-in link
// (POST /api/auth/magic-link generates a link pointing here). Completes
// Firebase's email-link flow client-side, then mints the same __session
// cookie Google sign-in uses via /api/auth/session.
export default function VerifyPage() {
  const [status, setStatus] = useState<Status>("checking");
  const [error, setError] = useState<string | null>(null);
  const [emailInput, setEmailInput] = useState("");

  async function complete(email: string) {
    setStatus("verifying");
    try {
      const auth = getFirebaseAuth();
      const cred = await signInWithEmailLink(auth, email, window.location.href);
      try {
        window.localStorage.removeItem(EMAIL_FOR_SIGN_IN_KEY);
      } catch {
        // ignore — best-effort cleanup only
      }
      const idToken = await cred.user.getIdToken();
      const res = await fetch("/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json", [ANON_ID_HEADER]: getAnonId() },
        body: JSON.stringify({ idToken }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Sign-in failed.");
      }
      setStatus("done");
      const params = new URLSearchParams(window.location.search);
      const returnTo = params.get("return") || "/account";
      window.location.replace(returnTo);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "This link may have expired or already been used."
      );
      setStatus("error");
    }
  }

  useEffect(() => {
    const auth = getFirebaseAuth();
    if (!isSignInWithEmailLink(auth, window.location.href)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError("This isn't a valid sign-in link.");
      setStatus("error");
      return;
    }
    let storedEmail: string | null = null;
    try {
      storedEmail = window.localStorage.getItem(EMAIL_FOR_SIGN_IN_KEY);
    } catch {
      // Private browsing / storage blocked — fall through to prompting.
    }
    if (storedEmail) {
      complete(storedEmail);
    } else {
      setStatus("needs-email");
    }
  }, []);

  return (
    <div className="mx-auto mt-24 max-w-sm p-6 text-center">
      <h1 className="mb-4 text-lg font-semibold">Signing you in</h1>

      {(status === "checking" || status === "verifying") && (
        <p className="text-sm text-ink-soft">One moment…</p>
      )}

      {status === "needs-email" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            complete(emailInput);
          }}
          className="space-y-3"
        >
          <p className="text-sm text-ink-soft">
            Confirm the email this link was sent to — you opened it on a
            different device or browser than the one that requested it.
          </p>
          <input
            type="email"
            required
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
            placeholder="you@example.com"
            className="w-full rounded border border-ink-soft/30 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            className="w-full rounded bg-black px-3 py-2 text-sm text-white"
          >
            Continue
          </button>
        </form>
      )}

      {status === "error" && (
        <p className="text-sm text-red-600">{error}</p>
      )}
    </div>
  );
}
