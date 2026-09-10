"use client";

import { useState } from "react";
import { ExternalLink, Loader2, RefreshCw, AlertTriangle } from "lucide-react";
import type { OrderDTO } from "@/lib/types";

const STATUS_LABEL: Record<string, string> = {
  in_review: "In review",
  printing: "Printing",
  dispatched: "Dispatched",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  rejected: "Rejected",
  failed: "Failed",
  cancelled: "Cancelled",
};

// From "dispatched" onward, a tracking number (when we have one) is shown —
// as a clickable new-tab link when Printrove's live response gave us a
// trackingUrl, otherwise as plain text (never a guessed courier link).
const TRACKING_VISIBLE_STATUSES = new Set(["dispatched", "out_for_delivery", "delivered"]);

/** Read-only order card for /account/orders — modeled on the admin queue's
 *  QueueCard, minus the approve/reject actions, plus a "Regenerate" button
 *  for rejected orders. */
export default function OrderCard({
  order,
  onRegenerated,
}: {
  order: OrderDTO;
  onRegenerated: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const simplified = order.simplifiedStatus ?? order.status;
  const isRejected = order.status === "rejected";
  const img = order.printroveMockupUrl || order.productPreviewImagePath || order.designPreviewImagePath;
  const showTracking = TRACKING_VISIBLE_STATUSES.has(simplified) && order.trackingNumber;

  async function regenerate() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/account/orders/${order.id}/regenerate`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not regenerate this design.");
      onRegenerated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not regenerate this design.");
      setBusy(false);
    }
  }

  return (
    <div className="sticker flex flex-col overflow-hidden rounded-2xl bg-paper-2">
      <div className="relative aspect-[4/5] alpha-grid">
        {isRejected ? (
          <div className="grid h-full place-items-center px-4 text-center font-mono text-xs text-ink-soft">
            Design unavailable — this order was rejected.
          </div>
        ) : img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={img}
            alt={`${order.title} — “${order.phrase}”`}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="grid h-full place-items-center font-mono text-xs text-ink-soft">
            no artwork
          </div>
        )}
        <span className="absolute right-3 top-3 rounded-full border-2 border-ink bg-paper px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider">
          {STATUS_LABEL[simplified] ?? simplified}
        </span>
      </div>

      <div className="flex flex-1 flex-col p-4">
        {!isRejected && (
          <>
            <h2 className="font-display text-xl font-bold leading-tight">{order.title}</h2>
            <p className="mt-1 text-sm text-ink-soft">“{order.phrase}”</p>
          </>
        )}

        {(order.variantSize || order.variantColor) && (
          <p className="mt-3 font-mono text-[11px] font-bold text-ink">
            {[order.variantColor, order.variantSize].filter(Boolean).join(" · ")}
            {order.quantity > 1 ? ` · ×${order.quantity}` : ""}
          </p>
        )}

        <p className="mt-2 font-mono text-[11px] text-ink-soft">
          Placed {new Date(order.createdAt).toLocaleDateString()}
        </p>

        {showTracking &&
          (order.trackingUrl ? (
            <a
              href={order.trackingUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex items-center gap-1.5 font-mono text-xs text-tea hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              Track {order.courierName ? `via ${order.courierName}` : "shipment"} · {order.trackingNumber}
            </a>
          ) : (
            <p className="mt-3 font-mono text-xs text-ink-soft">Tracking #{order.trackingNumber}</p>
          ))}

        {order.status === "failed" && (
          <p className="mt-3 flex items-start gap-1.5 font-mono text-xs text-pink-ink">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            Something went wrong placing this order — we&apos;re on it.
          </p>
        )}

        <div className="mt-4 flex-1" />

        {isRejected && (
          <>
            {order.canRegenerate ? (
              <button
                onClick={regenerate}
                disabled={busy}
                className="inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-ink bg-highlight px-3 py-2.5 font-mono text-xs font-bold uppercase tracking-wider text-ink transition-transform duration-200 hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <>
                    <RefreshCw className="h-4 w-4" aria-hidden /> Regenerate
                  </>
                )}
              </button>
            ) : (
              <p className="font-mono text-xs text-ink-soft">
                Already regenerated — check your Active orders for the new one.
              </p>
            )}
            {err && <p className="mt-2 font-mono text-xs text-pink-ink">{err}</p>}
          </>
        )}
      </div>
    </div>
  );
}
