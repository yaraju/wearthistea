"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, History } from "lucide-react";
import type { DesignDTO, DesignVersionSummary } from "@/lib/types";
import { getColorCode } from "@/lib/colors";
import { track } from "@/lib/analytics";
import PickDesignModal from "@/components/PickDesignModal";

/**
 * Interactive half of the shareable design page — the server component
 * (page.tsx) owns generateMetadata/data-fetching; this owns the "Pick this
 * one"/buy flow, which needs client state and reuses the exact same
 * PickDesignModal every other purchase path (KeywordStudio, pre-brewed
 * matches) uses, so a shared link converts through the real purchase flow
 * rather than being a dead-end showcase.
 *
 * `design` is already resolved server-side to the current-best version (see
 * getDesign() in page.tsx) — every visitor, admin or not, sees that art.
 * `versionChain`, when present, is the full lineage (issue #20); it's only
 * ever rendered for a viewer this component itself confirms is an admin
 * (same client-side /api/auth/me check every other admin surface in this
 * app uses — see admin/page.tsx's checkAuth()), so an ordinary shopper never
 * sees "other versions" chrome even though the data was sent down.
 */
export default function DesignPageClient({
  design,
  versionChain,
}: {
  design: DesignDTO;
  versionChain?: DesignVersionSummary[];
}) {
  const [open, setOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const img = design.designPreviewImagePath || design.productPreviewImagePath;

  useEffect(() => {
    if (!versionChain || versionChain.length <= 1) return;
    fetch("/api/auth/me", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => setIsAdmin(Boolean(data.isAdmin)))
      .catch(() => setIsAdmin(false));
  }, [versionChain]);

  return (
    <div className="mx-auto max-w-lg px-6 py-12">
      <Link href="/" className="font-display text-lg font-bold">
        wearthis<span className="text-tea-bright">tea</span>
        <span className="text-pink">.</span>
      </Link>

      {isAdmin && versionChain && versionChain.length > 1 && (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 font-mono text-[11px] text-amber-900">
          <p className="mb-1 flex items-center gap-1.5 font-bold uppercase tracking-wide">
            <History className="h-3.5 w-3.5" aria-hidden /> Version chain ({versionChain.length})
          </p>
          <ul className="space-y-0.5">
            {versionChain.map((v) => (
              <li key={v.id}>
                {v.slug ? (
                  <Link href={`/design/${v.slug}`} className="underline">
                    {v.title}
                  </Link>
                ) : (
                  <span>{v.title}</span>
                )}{" "}
                — {v.validationStatus}
                {v.isLatest ? " · latest" : ""}
                {v.isRequested ? " · viewing" : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div
        className="sticker mt-6 flex aspect-[4/5] items-center justify-center overflow-hidden rounded-2xl p-6"
        style={{ backgroundColor: getColorCode(design.variantColor || "Black") }}
      >
        {img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={img}
            alt={`${design.title} — design art reading “${design.phrase}”`}
            className="max-h-full max-w-full object-contain"
          />
        ) : null}
      </div>

      <h1 className="mt-6 font-display text-2xl font-bold leading-tight">{design.title}</h1>
      <p className="mt-1 text-sm text-ink-soft">“{design.phrase}”</p>
      {design.blurb && <p className="mt-3 text-sm text-ink-soft/90">{design.blurb}</p>}

      <button
        onClick={() => {
          track("select_design", { designId: design.id, fromSharedPage: true });
          setOpen(true);
        }}
        className="mt-6 inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-ink bg-highlight px-5 py-3 font-mono text-xs font-bold uppercase tracking-wider text-ink transition-transform duration-200 hover:-translate-y-0.5"
      >
        Make it yours <ArrowRight className="h-4 w-4" aria-hidden />
      </button>

      <p className="mt-8 font-mono text-xs text-ink-soft">
        Want to brew something of your own? <Link href="/#studio" className="underline">Head to the studio.</Link>
      </p>

      {open && <PickDesignModal design={design} onClose={() => setOpen(false)} onPlaced={() => setOpen(false)} />}
    </div>
  );
}
