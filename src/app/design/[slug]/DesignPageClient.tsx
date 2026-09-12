"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { DesignDTO } from "@/lib/types";
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
 */
export default function DesignPageClient({ design }: { design: DesignDTO }) {
  const [open, setOpen] = useState(false);
  const img = design.designPreviewImagePath || design.productPreviewImagePath;

  return (
    <div className="mx-auto max-w-lg px-6 py-12">
      <Link href="/" className="font-display text-lg font-bold">
        wearthis<span className="text-tea-bright">tea</span>
        <span className="text-pink">.</span>
      </Link>

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
