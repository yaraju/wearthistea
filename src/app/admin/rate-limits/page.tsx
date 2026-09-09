"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Trash2, Save } from "lucide-react";
import AdminLogin from "@/components/AdminLogin";

// Same client-side gate pattern as /admin — server-side enforcement is
// requireAdmin() on every /api/admin/rate-limits* route; this just avoids
// flashing a broken form at a signed-out visitor.
export default function RateLimitsPage() {
  const [authChecked, setAuthChecked] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  const checkAuth = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      setIsAdmin(Boolean(data.isAdmin));
    } catch {
      setIsAdmin(false);
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
        loading…
      </div>
    );
  }
  if (!isAdmin) {
    return <AdminLogin onSignedIn={checkAuth} />;
  }
  return <RateLimitsAdmin />;
}

interface Config {
  windowMs: number;
  maxAnonymous: number;
  maxSignedIn: number;
  maxAdmin: number;
  updatedAt?: string;
  updatedByEmail?: string | null;
}

interface Override {
  id: string;
  email: string;
  maxPerWindow: number;
  note: string | null;
}

function RateLimitsAdmin() {
  const [config, setConfig] = useState<Config | null>(null);
  const [windowMinutes, setWindowMinutes] = useState("60");
  const [maxAnonymous, setMaxAnonymous] = useState("10");
  const [maxSignedIn, setMaxSignedIn] = useState("25");
  const [maxAdmin, setMaxAdmin] = useState("1000");
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const [newEmail, setNewEmail] = useState("");
  const [newMax, setNewMax] = useState("");
  const [newNote, setNewNote] = useState("");
  const [addingOverride, setAddingOverride] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/rate-limits", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not load rate limits.");
      const c: Config = data.config;
      setConfig(c);
      setWindowMinutes(String(Math.round(c.windowMs / 60_000)));
      setMaxAnonymous(String(c.maxAnonymous));
      setMaxSignedIn(String(c.maxSignedIn));
      setMaxAdmin(String(c.maxAdmin));
      setOverrides(data.overrides ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load rate limits.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/rate-limits", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          windowMs: Number(windowMinutes) * 60_000,
          maxAnonymous: Number(maxAnonymous),
          maxSignedIn: Number(maxSignedIn),
          maxAdmin: Number(maxAdmin),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not save.");
      setConfig(data.config);
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 4000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  async function addOverride() {
    if (!newEmail.trim() || !newMax.trim()) return;
    setAddingOverride(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/rate-limits/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: newEmail.trim(),
          maxPerWindow: Number(newMax),
          note: newNote.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not add override.");
      setNewEmail("");
      setNewMax("");
      setNewNote("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add override.");
    } finally {
      setAddingOverride(false);
    }
  }

  async function removeOverride(id: string) {
    setOverrides((prev) => prev.filter((o) => o.id !== id));
    try {
      await fetch(`/api/admin/rate-limits/overrides/${id}`, { method: "DELETE" });
    } catch {
      // Best-effort optimistic remove — a reload will re-sync if this failed.
    }
  }

  return (
    <main className="min-h-screen">
      <header className="border-b-2 border-ink bg-ink text-paper">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-5">
          <div>
            <Link href="/admin" className="font-mono text-xs uppercase tracking-wider text-paper/60">
              ← Queue
            </Link>
            <h1 className="font-display text-2xl font-bold">Rate limits</h1>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-5 py-8">
        {error && (
          <p className="mb-4 rounded-lg border-2 border-red-600 bg-red-50 px-4 py-2 font-mono text-xs text-red-700">
            {error}
          </p>
        )}

        {loading ? (
          <div className="flex items-center gap-2 py-20 font-mono text-sm text-ink-soft">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> loading…
          </div>
        ) : (
          <>
            <section className="mb-10">
              <h2 className="kicker mb-2 text-ink-soft">image generations, per window</h2>
              <p className="mb-4 font-mono text-xs text-ink-soft">
                Applies to /api/generate/retry, /api/realize, and order regeneration — the
                paid Gemini image render, not the free concept-writing step. Takes effect
                for every server instance within ~15s of saving.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Window (minutes)" value={windowMinutes} onChange={setWindowMinutes} />
                <Field label="Anonymous (by session)" value={maxAnonymous} onChange={setMaxAnonymous} />
                <Field label="Signed-in customer" value={maxSignedIn} onChange={setMaxSignedIn} />
                <Field label="Admins (shared pool)" value={maxAdmin} onChange={setMaxAdmin} />
              </div>
              <button
                onClick={save}
                disabled={saving}
                className="mt-4 inline-flex cursor-pointer items-center gap-2 rounded-full border-2 border-ink bg-ink px-4 py-2 font-mono text-xs uppercase tracking-wider text-paper transition-colors duration-200 hover:bg-paper hover:text-ink disabled:opacity-50"
              >
                <Save className="h-3.5 w-3.5" aria-hidden />
                {saving ? "Saving…" : "Save"}
              </button>
              {justSaved && (
                <span className="ml-3 font-mono text-xs text-ink-soft">Saved.</span>
              )}
              {config?.updatedByEmail && (
                <p className="mt-2 font-mono text-[11px] text-ink-soft">
                  Last changed by {config.updatedByEmail}
                  {config.updatedAt ? ` on ${new Date(config.updatedAt).toLocaleString()}` : ""}
                </p>
              )}
            </section>

            <section>
              <h2 className="kicker mb-2 text-ink-soft">per-email overrides</h2>
              <p className="mb-4 font-mono text-xs text-ink-soft">
                Replaces the signed-in customer limit above for this exact email, using the
                same window. Has no effect on admin accounts.
              </p>

              <div className="mb-4 divide-y divide-line rounded-xl border-2 border-line">
                {overrides.length === 0 && (
                  <p className="px-4 py-3 font-mono text-xs text-ink-soft">No overrides yet.</p>
                )}
                {overrides.map((o) => (
                  <div key={o.id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-sm">{o.email}</p>
                      {o.note && <p className="truncate font-mono text-[11px] text-ink-soft">{o.note}</p>}
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="font-mono text-sm">{o.maxPerWindow} / window</span>
                      <button
                        onClick={() => removeOverride(o.id)}
                        aria-label={`Remove override for ${o.email}`}
                        className="cursor-pointer text-ink-soft hover:text-red-600"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <div className="grid gap-3 sm:grid-cols-[2fr_1fr_2fr_auto] sm:items-end">
                <Field label="Email" value={newEmail} onChange={setNewEmail} type="email" />
                <Field label="Max / window" value={newMax} onChange={setNewMax} />
                <Field label="Note (optional)" value={newNote} onChange={setNewNote} />
                <button
                  onClick={addOverride}
                  disabled={addingOverride || !newEmail.trim() || !newMax.trim()}
                  className="cursor-pointer rounded-full border-2 border-ink bg-ink px-4 py-2 font-mono text-xs uppercase tracking-wider text-paper transition-colors duration-200 hover:bg-paper hover:text-ink disabled:opacity-50"
                >
                  {addingOverride ? "Adding…" : "Add"}
                </button>
              </div>
            </section>
          </>
        )}
      </div>
    </main>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block font-mono text-[11px] uppercase tracking-wider text-ink-soft">
        {label}
      </span>
      <input
        type={type}
        inputMode={type === "text" ? undefined : "numeric"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border-2 border-line bg-paper-2 px-3 py-2 font-mono text-sm outline-none focus:border-ink"
      />
    </label>
  );
}
