"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { OrderDTO } from "@/lib/types";
import OrderCard from "@/components/OrderCard";

// The sign-in gate lives in account/layout.tsx — this only ever renders
// once the visitor is already confirmed signed in.
export default function OrdersPage() {
  const [active, setActive] = useState<OrderDTO[] | null>(null);
  const [past, setPast] = useState<OrderDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/account/orders", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not load your orders.");
      setActive(data.active ?? []);
      setPast(data.past ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your orders.");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const loading = active === null && past === null && !error;

  return (
    <div className="mx-auto max-w-5xl p-6">
      <h1 className="mb-1 font-display text-xl font-bold">Your orders</h1>
      <p className="mb-6 font-mono text-xs text-ink-soft">
        Every order you&apos;ve placed — active up top, past orders below.
      </p>

      {error && <p className="mb-6 font-mono text-xs text-pink-ink">{error}</p>}

      {loading ? (
        <Loader2 className="h-5 w-5 animate-spin text-ink-soft" aria-hidden />
      ) : (
        <div className="space-y-10">
          <section>
            <h2 className="mb-3 font-mono text-xs font-bold uppercase tracking-widest text-ink">
              Active
            </h2>
            {active && active.length > 0 ? (
              <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {active.map((o) => (
                  <OrderCard key={o.id} order={o} onRegenerated={load} />
                ))}
              </div>
            ) : (
              <p className="font-mono text-xs text-ink-soft">No active orders right now.</p>
            )}
          </section>

          <section>
            <h2 className="mb-3 font-mono text-xs font-bold uppercase tracking-widest text-ink">
              Past
            </h2>
            {past && past.length > 0 ? (
              <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {past.map((o) => (
                  <OrderCard key={o.id} order={o} onRegenerated={load} />
                ))}
              </div>
            ) : (
              <p className="font-mono text-xs text-ink-soft">Nothing here yet.</p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
