"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Loader2, Plus, Star } from "lucide-react";
import type { AddressDTO } from "@/lib/types";
import CustomerSignIn from "@/components/CustomerSignIn";

const FIELD_CLS =
  "w-full rounded-lg border border-line bg-paper px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-soft/60 focus:border-ink focus:outline-none";

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

function AddAddressForm({
  hasAny,
  onSaved,
  onCancel,
}: {
  hasAny: boolean;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    label: "",
    name: "",
    phone: "",
    address1: "",
    address2: "",
    city: "",
    state: "",
    pincode: "",
    country: "India",
    isDefault: !hasAny,
  });

  const set =
    (k: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/addresses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not save this address.");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save this address.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="mt-3 space-y-2.5 rounded-lg border border-line p-3">
      <input placeholder="Label (optional, e.g. Home)" value={form.label} onChange={set("label")} className={FIELD_CLS} />
      <input required placeholder="Full name" value={form.name} onChange={set("name")} className={FIELD_CLS} />
      <input required type="tel" placeholder="Phone" value={form.phone} onChange={set("phone")} className={FIELD_CLS} />
      <input required placeholder="Address line 1" value={form.address1} onChange={set("address1")} className={FIELD_CLS} />
      <input placeholder="Address line 2 (optional)" value={form.address2} onChange={set("address2")} className={FIELD_CLS} />
      <div className="flex gap-2">
        <input placeholder="City" value={form.city} onChange={set("city")} className={FIELD_CLS} />
        <input placeholder="State" value={form.state} onChange={set("state")} className={FIELD_CLS} />
      </div>
      <div className="flex gap-2">
        <input placeholder="PIN / ZIP" value={form.pincode} onChange={set("pincode")} className={FIELD_CLS} />
        <input required placeholder="Country" value={form.country} onChange={set("country")} className={FIELD_CLS} />
      </div>
      {hasAny && (
        <label className="flex items-center gap-1.5 font-mono text-[11px] text-ink">
          <input
            type="checkbox"
            checked={form.isDefault}
            onChange={(e) => setForm((f) => ({ ...f, isDefault: e.target.checked }))}
          />
          Make this my default address
        </label>
      )}
      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-ink px-3 py-2 font-mono text-xs font-bold uppercase tracking-widest text-paper disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save address"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-line px-3 py-2 font-mono text-xs text-ink-soft"
        >
          Cancel
        </button>
      </div>
      {error && <p className="font-mono text-xs text-pink-ink">{error}</p>}
    </form>
  );
}
