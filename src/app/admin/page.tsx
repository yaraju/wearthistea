"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Loader2,
  Check,
  X,
  ExternalLink,
  RefreshCw,
  AlertTriangle,
} from "lucide-react";
import type { OrderDTO } from "@/lib/types";
import { track } from "@/lib/analytics";
import AdminLogin from "@/components/AdminLogin";
import AdminReviewModal from "@/components/AdminReviewModal";

type Row = OrderDTO;

interface PendingReviewDesign {
  id: string;
  title: string;
  phrase: string;
  designImagePath: string;
  productImagePath: string;
  designPreviewImagePath: string;
  productPreviewImagePath: string;
  backDesignPreviewImagePath: string | null;
  variantColor: string | null;
  products: { id: string; category: string; label: string; status: string }[];
}

const FILTERS = ["pending", "published", "rejected", "failed", "all"] as const;
type Filter = (typeof FILTERS)[number];

// Gate: this page still sits behind sitewide Basic Auth (proxy.ts) in
// production, but that's a shared secret, not "you specifically" — this
// checks for a Firebase session belonging to the admin account before
// rendering the queue. The real enforcement is server-side (every
// /api/admin/* route calls requireAdmin()); this is just so an unsigned-in
// visitor sees a sign-in form instead of a broken, empty queue.
export default function AdminPage() {
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
  return <AdminQueue onSignOut={() => setIsAdmin(false)} />;
}

function AdminQueue({ onSignOut }: { onSignOut: () => void }) {
  const [filter, setFilter] = useState<Filter>("pending");
  const [rows, setRows] = useState<Row[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/admin/batches?status=${filter}`, {
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(
          [data.error, data.hint].filter(Boolean).join(" — ") ||
            "Could not load the queue."
        );
      setRows(data.orders ?? []);
      setCounts(data.counts ?? {});
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load the queue.");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    // Fetch the queue on mount and whenever the filter changes. The brief
    // loading flip inside load() is the intended UX here, not a render bug.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const [reviewDesigns, setReviewDesigns] = useState<PendingReviewDesign[]>([]);
  const [openReview, setOpenReview] = useState<PendingReviewDesign | null>(null);

  const loadReviewDesigns = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/designs/pending-review", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      setReviewDesigns(data.designs ?? []);
    } catch {
      setReviewDesigns([]);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadReviewDesigns();
  }, [loadReviewDesigns]);

  return (
    <main className="min-h-screen">
      <header className="border-b-2 border-ink bg-ink text-paper">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
          <div>
            <Link href="/" className="font-display text-2xl font-bold">
              wearthis<span className="text-tea-bright">tea</span>
              <span className="text-pink">.</span>
            </Link>
            <h1 className="kicker mt-1 text-paper/60">drop queue · phase 1</h1>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/admin/rate-limits"
              className="inline-flex cursor-pointer items-center gap-2 rounded-full border-2 border-paper px-4 py-2 font-mono text-xs uppercase tracking-wider transition-colors duration-200 hover:bg-paper hover:text-ink"
            >
              Rate limits
            </Link>
            <button
              onClick={load}
              className="inline-flex cursor-pointer items-center gap-2 rounded-full border-2 border-paper px-4 py-2 font-mono text-xs uppercase tracking-wider transition-colors duration-200 hover:bg-paper hover:text-ink"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Refresh
            </button>
            <button
              onClick={async () => {
                await fetch("/api/auth/logout", { method: "POST" });
                onSignOut();
              }}
              className="inline-flex cursor-pointer items-center gap-2 rounded-full border-2 border-paper px-4 py-2 font-mono text-xs uppercase tracking-wider transition-colors duration-200 hover:bg-paper hover:text-ink"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-5 py-8">
        {/* Content review — approve/reject a (design, apparel type, color)
            combo once, covers every current + future buyer of that combo.
            Only shows designs with a real order waiting on a decision. */}
        {reviewDesigns.length > 0 && (
          <div className="mb-8">
            <h2 className="kicker mb-2 text-ink-soft">needs review</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {reviewDesigns.map((d) => {
                const img = d.designPreviewImagePath || d.productPreviewImagePath;
                return (
                  <button
                    key={d.id}
                    onClick={() => {
                      track("design_review_opened", { designId: d.id });
                      setOpenReview(d);
                    }}
                    className="sticker flex items-center gap-3 rounded-xl bg-paper-2 p-3 text-left transition-transform duration-200 hover:-translate-y-0.5"
                  >
                    {img && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={img}
                        alt={d.title}
                        className="h-14 w-14 shrink-0 rounded-lg object-contain"
                      />
                    )}
                    <div className="min-w-0">
                      <p className="truncate font-display text-sm font-bold">{d.title}</p>
                      <p className="font-mono text-[11px] text-ink-soft">
                        {d.products.length} apparel type{d.products.length === 1 ? "" : "s"} pending
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {openReview && (
          <AdminReviewModal
            design={openReview}
            items={openReview.products}
            onClose={() => setOpenReview(null)}
            onDone={() => {
              setOpenReview(null);
              loadReviewDesigns();
              load();
            }}
          />
        )}

        {/* Filters */}
        <div className="mb-8 flex flex-wrap gap-2">
          {FILTERS.map((f) => {
            const active = filter === f;
            const n = f === "all" ? undefined : counts[f];
            return (
              <button
                key={f}
                onClick={() => setFilter(f)}
                aria-pressed={active}
                className={`cursor-pointer rounded-full border-2 px-4 py-1.5 font-mono text-xs uppercase tracking-wider transition-colors duration-200 ${
                  active
                    ? "border-ink bg-ink text-paper"
                    : "border-line bg-paper-2 text-ink-soft hover:border-ink hover:text-ink"
                }`}
              >
                {f}
                {n !== undefined && (
                  <span className="ml-1.5 opacity-70">{n}</span>
                )}
              </button>
            );
          })}
        </div>

        {loading ? (
          <div className="flex items-center gap-2 py-20 font-mono text-sm text-ink-soft">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> loading the queue…
          </div>
        ) : loadError ? (
          <div
            role="alert"
            className="sticker flex items-start gap-3 rounded-2xl bg-paper-2 p-6"
          >
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-pink" aria-hidden />
            <div>
              <p className="font-display text-xl font-bold">Queue unavailable</p>
              <p className="mt-1 font-mono text-sm text-ink-soft">{loadError}</p>
            </div>
          </div>
        ) : rows.length === 0 ? (
          <div className="sticker rounded-2xl bg-paper-2 p-12 text-center">
            <p className="font-display text-2xl font-bold">No {filter} drops.</p>
            <p className="mt-2 text-sm text-ink-soft">
              When someone picks a design on the landing page, it lands here for
              your approval.
            </p>
          </div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((row) => (
              <QueueCard key={row.id} row={row} onChange={load} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function QueueCard({ row, onChange }: { row: Row; onChange: () => void }) {
  const [busy, setBusy] = useState<null | "approve" | "reject" | "retry" | "refund">(null);
  const [err, setErr] = useState<string | null>(null);

  async function act(kind: "approve" | "reject" | "retry" | "refund") {
    setBusy(kind);
    setErr(null);
    try {
      const endpoint = kind === "retry" ? "approve" : kind;
      const res = await fetch(`/api/admin/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: row.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Action failed.");
      onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  }

  const img = row.printroveMockupUrl || row.productImagePath || row.designImagePath;
  const isPending = row.status === "pending";
  const isFailed = row.status === "failed";
  const hasArtwork = Boolean(row.hasImageData);
  // Prepaid introduces a failure mode COD never had: money already moved,
  // then fulfillment failed or you rejected it — offer to give it back.
  const canRefund =
    row.paymentProvider === "razorpay" &&
    row.paymentStatus === "paid" &&
    (row.status === "failed" || row.status === "rejected");

  return (
    <div className="sticker flex flex-col overflow-hidden rounded-2xl bg-paper-2">
      <div className="relative aspect-[4/5] alpha-grid">
        {img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={img}
            alt={`${row.title} — “${row.phrase}”`}
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
          {row.status}
        </span>
      </div>

      <div className="flex flex-1 flex-col p-4">
        <p className="kicker text-ink-soft">tea: {row.batch.keyword}</p>
        <h2 className="mt-1 font-display text-xl font-bold leading-tight">
          {row.title}
        </h2>
        <p className="mt-1 text-sm text-ink-soft">“{row.phrase}”</p>

        {(row.variantSize || row.recipientName) && (
          <div className="mt-3 space-y-1 rounded-lg border border-line bg-paper p-2.5 font-mono text-[11px] text-ink-soft">
            {(row.variantColor || row.variantSize) && (
              <p className="font-bold text-ink">
                {[row.variantColor, row.variantSize].filter(Boolean).join(" · ")}
                {row.quantity > 1 ? ` · ×${row.quantity}` : ""}
              </p>
            )}
            {row.recipientName && (
              <p>
                {row.recipientName}
                {row.recipientPhone ? ` · ${row.recipientPhone}` : ""}
              </p>
            )}
            {row.addressLine1 && (
              <p className="leading-snug">
                {[
                  row.addressLine1,
                  row.addressLine2,
                  row.city,
                  row.state,
                  row.pincode,
                  row.country,
                ]
                  .filter(Boolean)
                  .join(", ")}
              </p>
            )}
            {row.recipientName && (
              <p className="uppercase tracking-wider text-tea">
                {row.cod
                  ? "Cash on delivery"
                  : `Prepaid · ${row.paymentStatus === "paid" ? "paid" : "awaiting payment"}`}
              </p>
            )}
          </div>
        )}

        {row.printroveUrl && (
          <a
            href={row.printroveUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 font-mono text-xs text-tea hover:underline"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden /> view live product
          </a>
        )}
        {row.printroveOrderId && (
          <p className="mt-3 font-mono text-xs text-tea">
            Order placed · #{row.printroveOrderId}
            {row.trackingNumber ? ` · track ${row.trackingNumber}` : ""}
          </p>
        )}
        {row.printroveProductId && !row.printroveUrl && !row.printroveOrderId && (
          <p className="mt-3 font-mono text-xs text-tea">
            Product #{row.printroveProductId}
          </p>
        )}
        {row.errorMessage && (
          <p className="mt-3 flex items-start gap-1.5 font-mono text-xs text-pink-ink">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {row.errorMessage}
          </p>
        )}

        <div className="mt-4 flex-1" />

        {isPending && (
          <div className="flex gap-2">
            <button
              onClick={() => act("approve")}
              disabled={busy !== null}
              className="inline-flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-ink bg-tea-bright px-3 py-2.5 font-mono text-xs font-bold uppercase tracking-wider text-ink transition-transform duration-200 hover:-translate-y-0.5 disabled:opacity-50"
            >
              {busy === "approve" ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <>
                  <Check className="h-4 w-4" aria-hidden /> Approve &amp; print
                </>
              )}
            </button>
            <button
              onClick={() => act("reject")}
              disabled={busy !== null}
              className="inline-flex cursor-pointer items-center justify-center rounded-xl border-2 border-ink bg-paper px-3 py-2.5 text-ink transition-colors duration-200 hover:bg-ink hover:text-paper disabled:opacity-50"
              aria-label="Reject"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        )}

        {isFailed && hasArtwork && (
          <button
            onClick={() => act("retry")}
            disabled={busy !== null}
            className="inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-ink bg-paper px-3 py-2.5 font-mono text-xs font-bold uppercase tracking-wider text-ink transition-transform duration-200 hover:-translate-y-0.5 disabled:opacity-50"
          >
            {busy === "retry" ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <>
                <RefreshCw className="h-4 w-4" aria-hidden /> Retry &amp; print
              </>
            )}
          </button>
        )}

        {canRefund && (
          <button
            onClick={() => act("refund")}
            disabled={busy !== null}
            className="mt-2 inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-pink px-3 py-2.5 font-mono text-xs font-bold uppercase tracking-wider text-pink-ink transition-transform duration-200 hover:-translate-y-0.5 disabled:opacity-50"
          >
            {busy === "refund" ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              "Refund"
            )}
          </button>
        )}

        {err && <p className="mt-2 text-xs text-pink-ink">{err}</p>}
      </div>
    </div>
  );
}
