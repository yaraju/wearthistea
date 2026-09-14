"use client";

import { useState } from "react";
import { Loader2, Check, X, AlertTriangle } from "lucide-react";
import { track } from "@/lib/analytics";
import DesignProductPreview from "@/components/DesignProductPreview";

// Lean chain-entry shape both pending-review and catalog routes send down
// when (and only when) a design is actually superseded — see
// src/lib/design-versions.ts's getDesignVersionChain().
export interface DesignVersionChainSummary {
  id: string;
  slug: string | null;
  title: string;
  validationStatus: string;
  isLatest: boolean;
}

interface ReviewItem {
  id: string; // DesignProduct id
  category: string;
  label: string;
  // Catalog mode only: the combo's real current approvalStatus, used to
  // seed `decided` on open so an already-decided combo shows its true state
  // (and can be re-flipped) instead of looking undecided.
  approvalStatus?: "unreviewed" | "approved" | "rejected";
}

interface DesignSummary {
  id: string;
  title: string;
  phrase: string;
  designImagePath: string;
  productImagePath: string;
  designPreviewImagePath: string;
  productPreviewImagePath: string;
  backDesignPreviewImagePath: string | null;
  variantColor: string | null;
  // Catalog mode only — extra debug metadata, absent in queue mode.
  visualConcept?: string;
  designPrompt?: string;
  productPrompt?: string;
  keyword?: string;
  createdAt?: string;
  createdByEmail?: string | null;
  status?: string;
  // Version-chain awareness (issue #20) — present whenever the API included
  // it, which is only when this design is actually validationStatus ===
  // "superseded" (see pending-review/route.ts and catalog/route.ts).
  validationStatus?: string;
  versionChain?: DesignVersionChainSummary[];
}

/**
 * Admin-mode counterpart to PickDesignModal: same underlying preview
 * (DesignProductPreview) for every category at once instead of one at a
 * time, each with Approve/Reject, plus Approve All to clear everything
 * shown in one click when it all looks fine.
 *
 * mode="queue" (default): the focused pending-review flow, unchanged —
 * decide each combo once, it locks into a static Approved/Rejected label.
 * mode="catalog": the browsable admin debug catalog — shows every combo
 * (not just unreviewed ones) with its real current status, allows
 * re-flipping any decision at any time (decideDesignProduct() already
 * handles re-triggering provider pushes/order rejections on a change), adds
 * a metadata panel and a Regenerate action.
 */
export default function AdminReviewModal({
  design,
  items,
  onClose,
  onDone,
  mode = "queue",
}: {
  design: DesignSummary;
  items: ReviewItem[];
  onClose: () => void;
  onDone: () => void;
  mode?: "queue" | "catalog";
}) {
  const [busy, setBusy] = useState<string | null>(null); // "all" | "regenerate" | DesignProduct id
  const [decided, setDecided] = useState<Record<string, "approved" | "rejected">>(() => {
    if (mode !== "catalog") return {};
    const seed: Record<string, "approved" | "rejected"> = {};
    for (const it of items) {
      if (it.approvalStatus === "approved" || it.approvalStatus === "rejected") {
        seed[it.id] = it.approvalStatus;
      }
    }
    return seed;
  });
  const [err, setErr] = useState<string | null>(null);
  const [regenerateMsg, setRegenerateMsg] = useState<string | null>(null);

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

  // Catalog-mode-only: spawn a fresh sibling Design from the same concept
  // (never re-render this row in place — see regenerate/route.ts), then kick
  // off its actual render via the same retry endpoint a fresh brew uses.
  // Fire-and-forget on the render step: it can take up to ~30-60s, same as
  // any other render, so this doesn't block the modal — the sibling shows
  // up in the catalog (as "generating", then done/failed) on next refresh.
  async function regenerate() {
    setBusy("regenerate");
    setRegenerateMsg(null);
    try {
      const res = await fetch(`/api/admin/designs/${design.id}/regenerate`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not regenerate.");
      track("design_regenerated", { sourceDesignId: design.id, newDesignId: data.design.id });
      setRegenerateMsg("Regenerating in the background — refresh the catalog shortly to see it.");
      fetch("/api/generate/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ designId: data.design.id }),
      }).catch(() => {
        // Best-effort — a failed render shows up as status "failed" on the
        // sibling in the catalog either way; nothing to surface here.
      });
    } catch (e) {
      setRegenerateMsg(e instanceof Error ? e.message : "Could not regenerate.");
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
            {mode === "catalog" && (
              <button
                onClick={regenerate}
                disabled={busy !== null}
                className="rounded border border-gray-400 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-gray-700 disabled:opacity-50"
              >
                {busy === "regenerate" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Regenerate"}
              </button>
            )}
            <button onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-black">
              <X className="h-5 w-5" aria-hidden />
            </button>
          </div>
        </div>

        {design.validationStatus === "superseded" && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 font-mono text-[11px] text-amber-900">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <div>
              <p className="font-bold">This design has been superseded by a regenerated sibling.</p>
              {design.versionChain && design.versionChain.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {design.versionChain.map((v) => (
                    <li key={v.id}>
                      {v.slug ? (
                        <a href={`/design/${v.slug}`} target="_blank" rel="noreferrer" className="underline">
                          {v.title}
                        </a>
                      ) : (
                        v.title
                      )}{" "}
                      — {v.validationStatus}
                      {v.isLatest ? " · latest" : ""}
                      {v.id === design.id ? " · this one" : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {mode === "catalog" && (
          <div className="mb-4 rounded-lg bg-gray-50 p-3 font-mono text-[11px] text-gray-600">
            <p><span className="font-bold">status:</span> {design.status}</p>
            <p><span className="font-bold">keyword:</span> {design.keyword}</p>
            {design.createdAt && (
              <p><span className="font-bold">created:</span> {new Date(design.createdAt).toLocaleString()}</p>
            )}
            <p><span className="font-bold">brewed by:</span> {design.createdByEmail || "anonymous"}</p>
            {design.visualConcept && (
              <p className="mt-1"><span className="font-bold">visualConcept:</span> {design.visualConcept}</p>
            )}
            {design.designPrompt && (
              <p className="mt-1"><span className="font-bold">designPrompt:</span> {design.designPrompt}</p>
            )}
            {design.productPrompt && (
              <p className="mt-1"><span className="font-bold">productPrompt:</span> {design.productPrompt}</p>
            )}
            {regenerateMsg && <p className="mt-2 text-black">{regenerateMsg}</p>}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {items.map((it) => (
            <div key={it.id} className="rounded-lg border border-gray-200 p-3">
              <p className="mb-2 text-xs font-bold uppercase tracking-wide text-gray-600">
                {it.label}
              </p>
              <DesignProductPreview
                designId={design.id}
                category={it.category}
                previewImageUrl={brewedPreviewImg}
                brewedImageUrl={brewedImg}
                brewedImageAlt={`${design.title} — ${it.label}`}
                garmentColor={design.variantColor || "Black"}
                backPreviewImageUrl={design.backDesignPreviewImagePath || undefined}
              />
              {mode === "catalog" ? (
                // Catalog mode: always-clickable, re-flippable at any time —
                // the currently-active decision is filled, the other is an
                // outline. decideDesignProduct() already handles
                // re-triggering provider pushes/order rejections on change.
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => review(it.id, "approved")}
                    disabled={busy !== null}
                    className={`flex-1 rounded px-2 py-1.5 text-xs font-bold disabled:opacity-50 ${
                      decided[it.id] === "approved"
                        ? "bg-green-600 text-white"
                        : "border border-green-600 text-green-600"
                    }`}
                  >
                    {busy === it.id ? <Loader2 className="mx-auto h-3.5 w-3.5 animate-spin" aria-hidden /> : "Approve"}
                  </button>
                  <button
                    onClick={() => review(it.id, "rejected")}
                    disabled={busy !== null}
                    className={`flex-1 rounded px-2 py-1.5 text-xs font-bold disabled:opacity-50 ${
                      decided[it.id] === "rejected"
                        ? "bg-red-600 text-white"
                        : "border border-red-600 text-red-600"
                    }`}
                  >
                    Reject
                  </button>
                </div>
              ) : decided[it.id] ? (
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

        {mode === "queue" && remaining.length === 0 && (
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
