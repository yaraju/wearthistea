"use client";

import { useState, type FormEvent, type ChangeEvent } from "react";
import type { AddressDTO } from "@/lib/types";
import { friendlyError } from "@/lib/error-messages";

const FIELD_CLS =
  "w-full rounded-lg border border-line bg-paper px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-soft/60 focus:border-ink focus:outline-none";

/** Add-a-saved-address form — shared by /account and the checkout modal's
 * "add another address" flow (both talk to the same POST /api/account/addresses). */
export default function AddAddressForm({
  hasAny,
  onSaved,
  onCancel,
}: {
  hasAny: boolean;
  onSaved: (address: AddressDTO) => void;
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
    (e: ChangeEvent<HTMLInputElement>) =>
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
      onSaved(data.address as AddressDTO);
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
      {error && <p className="font-mono text-xs text-pink-ink">{friendlyError(error)}</p>}
    </form>
  );
}
