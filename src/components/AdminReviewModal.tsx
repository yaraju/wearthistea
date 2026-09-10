"use client";

import { useState } from "react";
import { Loader2, Check, X } from "lucide-react";
import { track } from "@/lib/analytics";
import DesignProductPreview from "@/components/DesignProductPreview";

interface ReviewItem {
  id: string; // DesignProduct id
  category: string;
  label: string;
}

interface DesignSummary {
  id: string;
  title: string;
  phrase: string;
  designImagePath: string;
  productImagePath: string;
  designPreviewImagePath: string;
  productPreviewImagePath: string;
  variantColor: string | null;
}

/**
 * Admin-mode counterpart to PickDesignModal: same underlying preview
 * (DesignProductPreview) for every category at once instead of one at a
 * time, each with Approve/Reject, plus Approve All to clear everything
 * shown in one click when it all looks fine.
 */
export default function AdminReviewModal({
  design,
  items,
  onClose,
  onDone,
}: {
  design: DesignSummary;
  items: ReviewItem[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null); // "all" | DesignProduct id
  const [decided, setDecided] = useState<Record<string, "approved" | "rejected">>({});
  const [err, setErr] = useState<string | null>(null);

  const brewedImg = design.designImagePath || design.productImagePath;
  const brewedPreviewImg = design.designPreviewImagePath || design.productPreviewImagePath;
  const remaining = items.filter((it) => !decided[it.id]);

  async function review(designProductId: string, decision: "approved" | "rejected") {
    setBusy(designProductId);
    setErr(null);
    try {
      const res = await fetch(`/api/admin/design-products/${designProductId}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not save this decision.");
      track(decision === "approved" ? "design_approved" : "design_rejected", {
        designId: design.id,
        designProductId,
      });
      setDecided((d) => ({ ...d, [designProductId]: decision }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed.");
    } finally {
      setBusy(null);
    }
  }

  async function approveAll() {
    setBusy("all");
    setErr(null);
    try {
      const res = await fetch(`/api/admin/designs/${design.id}/approve-all`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not approve all.");
      track("design_approved_all", { designId: design.id });
      setDecided((d) => {
        const next = { ...d };
        for (const it of items) next[it.id] = "approved";
        return next;
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold">{design.title}</h3>
            <p className="text-xs text-gray-500">&quot;{design.phrase}&quot;</p>
          </div>
          <div className="flex items-center gap-2">
            {remaining.length > 1 && (
              <button
                onClick={approveAll}
                disabled={busy !== null}
                className="rounded bg-green-600 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-white disabled:opacity-50"
              >
                {busy === "all" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Approve All"}
              </button>
            )}
            <button onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-black">
              <X className="h-5 w-5" aria-hidden />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {items.map((it) => (
            <div key={it.id} className="rounded-lg border border-gray-200 p-3">
              <p className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-600">
                {it.label}
              </p>
              <DesignProductPreview
                designId={design.id}
                category={it.category}
                brewedImageUrl={brewedImg}
                brewedImageAlt={`${design.title} — ${it.label}`}
                garmentColor={design.variantColor || "Black"}
              />
              {brewedPreviewImg && (
                <div className="mt-2 flex items-center gap-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={brewedPreviewImg}
                    alt="What the customer sees (preview quality)"
                    className="h-10 w-10 rounded border border-gray-200 object-contain"
                  />
                  <p className="text-[10px] text-gray-500">
                    Customer sees this preview-quality version — full-res above is what prints.
                  </p>
                </div>
              )}
              {decided[it.id] ? (
                <p
                  className={`mt-2 flex items-center gap-1 text-xs font-bold ${
                    decided[it.id] === "approved" ? "text-green-600" : "text-red-600"
                  }`}
                >
                  {decided[it.id] === "approved" ? (
                    <>
                      <Check className="h-3.5 w-3.5" aria-hidden /> Approved
                    </>
                  ) : (
                    <>
                      <X className="h-3.5 w-3.5" aria-hidden /> Rejected
                    </>
                  )}
                </p>
              ) : (
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => review(it.id, "approved")}
                    disabled={busy !== null}
                    className="flex-1 rounded bg-green-600 px-2 py-1.5 text-xs font-bold text-white disabled:opacity-50"
                  >
                    {busy === it.id ? <Loader2 className="mx-auto h-3.5 w-3.5 animate-spin" aria-hidden /> : "Approve"}
                  </button>
                  <button
                    onClick={() => review(it.id, "rejected")}
                    disabled={busy !== null}
                    className="flex-1 rounded border border-red-600 px-2 py-1.5 text-xs font-bold text-red-600 disabled:opacity-50"
                  >
                    Reject
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        {err && <p className="mt-3 text-xs text-red-600">{err}</p>}

        {remaining.length === 0 && (
          <button
            onClick={onDone}
            className="mt-4 w-full rounded bg-black px-3 py-2 text-xs font-bold uppercase tracking-wide text-white"
          >
            Done
          </button>
        )}
      </div>
    </div>
  );
}
