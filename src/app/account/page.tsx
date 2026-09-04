"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Star } from "lucide-react";
import type { AddressDTO } from "@/lib/types";
import CustomerSignIn from "@/components/CustomerSignIn";
import AddAddressForm from "@/components/AddAddressForm";

const PROVIDER_LABEL: Record<string, string> = {
  "google.com": "Google",
  email_link: "Email link",
};

export default function AccountPage() {
  const [authChecked, setAuthChecked] = useState(false);
  const [me, setMe] = useState<{ email: string | null; authProvider: string | null } | null>(null);

  const checkAuth = useCallback(async () => {
    try {
      const res = await fetch("/api/account/me", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      setMe(data.signedIn ? { email: data.email, authProvider: data.authProvider } : null);
    } catch {
      setMe(null);
    } finally {
      setAuthChecked(true);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    checkAuth();
  }, [checkAuth]);

  if (!authChecked) {
    return (
      <div className="grid min-h-screen place-items-center font-mono text-sm text-ink-soft">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
      </div>
    );
  }

  if (!me) {
    return (
      <div className="mx-auto mt-24 max-w-sm p-6">
        <h1 className="mb-4 font-display text-xl font-bold">Sign in</h1>
        <CustomerSignIn onSignedIn={checkAuth} />
      </div>
    );
  }

  return <AccountDashboard email={me.email} authProvider={me.authProvider} />;
}

function AccountDashboard({
  email,
  authProvider,
}: {
  email: string | null;
  authProvider: string | null;
}) {
  const [addresses, setAddresses] = useState<AddressDTO[] | null>(null);
  const [adding, setAdding] = useState(false);

  const loadAddresses = useCallback(async () => {
    const res = await fetch("/api/account/addresses", { cache: "no-store" });
    const data = await res.json().catch(() => ({ addresses: [] }));
    setAddresses(data.addresses ?? []);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAddresses();
  }, [loadAddresses]);

  return (
    <div className="mx-auto max-w-lg p-6">
      <h1 className="mb-1 font-display text-xl font-bold">Your account</h1>
      <p className="mb-6 font-mono text-xs text-ink-soft">
        {email} · signed in with {authProvider ? PROVIDER_LABEL[authProvider] ?? authProvider : "—"}
      </p>

      <h2 className="mb-2 font-mono text-xs font-bold uppercase tracking-widest text-ink">
        Saved addresses
      </h2>

      {addresses === null ? (
        <Loader2 className="h-4 w-4 animate-spin text-ink-soft" aria-hidden />
      ) : (
        <div className="space-y-2">
          {addresses.map((a) => (
            <div
              key={a.id}
              className="rounded-lg border border-line bg-paper-2 p-3 font-mono text-xs text-ink"
            >
              <div className="flex items-center gap-1.5">
                {a.isDefault && <Star className="h-3 w-3 fill-ink text-ink" aria-hidden />}
                <span className="font-bold">{a.label || a.name}</span>
              </div>
              <p className="mt-1 text-ink-soft">
                {a.name} · {a.phone}
                <br />
                {[a.address1, a.address2, a.city, a.state, a.pincode, a.country]
                  .filter(Boolean)
                  .join(", ")}
              </p>
            </div>
          ))}
          {addresses.length === 0 && (
            <p className="font-mono text-xs text-ink-soft">No saved addresses yet.</p>
          )}
        </div>
      )}

      {adding ? (
        <AddAddressForm
          hasAny={Boolean(addresses?.length)}
          onSaved={() => {
            setAdding(false);
            loadAddresses();
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="mt-3 flex items-center gap-1.5 font-mono text-xs font-bold uppercase tracking-widest text-ink-soft hover:text-ink"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden /> Add another address
        </button>
      )}
    </div>
  );
}
