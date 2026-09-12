"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Sparkles } from "lucide-react";
import type { DesignMatchDTO } from "@/lib/types";
import ReviewBadge from "@/components/ReviewBadge";

interface AccountDesign {
  id: string;
  slug: string | null;
  title: string;
  phrase: string;
  status: string;
  productPreviewImagePath: string;
  designPreviewImagePath: string;
  createdAt: string;
}

// The sign-in gate lives in account/layout.tsx — this only ever renders
// once the visitor is already confirmed signed in.
export default function AccountDesignsPage() {
  const [designs, setDesigns] = useState<AccountDesign[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (cursor?: string) => {
    try {
      const params = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const res = await fetch(`/api/account/designs${params}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not load your brews.");
      setDesigns((prev) => (cursor ? [...(prev ?? []), ...data.designs] : data.designs));
      setNextCursor(data.nextCursor ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your brews.");
    } finally {
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const loading = designs === null && !error;

  return (
    <div className="mx-auto max-w-5xl p-6">
      <h1 className="mb-1 font-display text-xl font-bold">Your brews</h1>
      <p className="mb-6 font-mono text-xs text-ink-soft">
        Every design you&apos;ve brewed, whether or not you ended up ordering it.
      </p>

      {error && <p className="mb-6 font-mono text-xs text-pink-ink">{error}</p>}

      {loading ? (
        <Loader2 className="h-5 w-5 animate-spin text-ink-soft" aria-hidden />
      ) : designs && designs.length > 0 ? (
        <>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {designs.map((d) => (
              <BrewCard key={d.id} design={d} />
            ))}
          </div>
          {nextCursor && (
            <div className="mt-6 flex justify-center">
              <button
                onClick={() => {
                  setLoadingMore(true);
                  load(nextCursor);
                }}
                disabled={loadingMore}
                className="rounded-full border-2 border-ink px-5 py-2 font-mono text-xs font-bold uppercase tracking-wider disabled:opacity-50"
              >
                {loadingMore ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : "Load more"}
              </button>
            </div>
          )}
        </>
      ) : (
        <p className="font-mono text-xs text-ink-soft">
          You haven&apos;t brewed anything yet — head to the studio and spill some tea.
        </p>
      )}
    </div>
  );
}

function BrewCard({ design }: { design: AccountDesign }) {
  const [similar, setSimilar] = useState<DesignMatchDTO[] | null>(null);
  const [loadingSimilar, setLoadingSimilar] = useState(false);
  const img = design.designPreviewImagePath || design.productPreviewImagePath;
  const shareable = design.status === "generated" && design.slug;

  async function findSimilar() {
    if (similar) {
      setSimilar(null); // toggle closed
      return;
    }
    setLoadingSimilar(true);
    try {
      const res = await fetch(`/api/account/designs/${design.id}/similar`);
      const data = await res.json().catch(() => ({ matches: [] }));
      setSimilar(data.matches ?? []);
    } finally {
      setLoadingSimilar(false);
    }
  }

  return (
    <div className="sticker flex flex-col overflow-hidden rounded-2xl bg-paper-2">
      <Link
        href={shareable ? `/design/${design.slug}` : "#"}
        className={`relative flex aspect-[4/5] items-center justify-center overflow-hidden bg-paper p-5 ${
          shareable ? "" : "pointer-events-none"
        }`}
      >
        {img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={img} alt={design.title} className="max-h-full max-w-full object-contain" />
        ) : (
          <span className="font-mono text-xs text-ink-soft">{design.status}</span>
        )}
      </Link>
      <div className="flex flex-1 flex-col p-4">
        <h3 className="font-display text-base font-bold leading-tight">{design.title}</h3>
        <p className="mt-1 text-xs text-ink-soft">“{design.phrase}”</p>
        <div className="mt-3 flex-1" />
        {design.status === "generated" && (
          <button
            onClick={findSimilar}
            disabled={loadingSimilar}
            className="inline-flex items-center gap-1.5 font-mono text-xs font-bold uppercase tracking-wide text-tea disabled:opacity-50"
          >
            {loadingSimilar ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Sparkles className="h-3.5 w-3.5" aria-hidden />
            )}
            {similar ? "Hide similar" : "Find similar"}
          </button>
        )}
      </div>

      {similar && similar.length > 0 && (
        <div className="grid grid-cols-3 gap-2 border-t border-ink/10 p-3">
          {similar.map((m) => (
            <Link key={m.id} href={m.slug ? `/design/${m.slug}` : "#"} className="relative block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={m.designPreviewImagePath || m.productPreviewImagePath}
                alt={m.title}
                className="aspect-square w-full rounded-lg object-contain bg-paper"
              />
              <span className="absolute bottom-1 left-1">
                <ReviewBadge status={m.reviewBadge} />
              </span>
            </Link>
          ))}
        </div>
      )}
      {similar && similar.length === 0 && (
        <p className="border-t border-ink/10 p-3 font-mono text-[11px] text-ink-soft">No similar brews yet.</p>
      )}
    </div>
  );
}
