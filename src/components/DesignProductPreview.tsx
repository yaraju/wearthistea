"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { DesignProductDTO } from "@/lib/types";
import { getColorCode } from "@/lib/colors";

/**
 * Polls GET /api/designs/[id]/product?category=X and renders a carousel:
 * the already-brewed AI art first, then the real Printrove mockup(s) once
 * ready. Shared by the customer pick-time modal and the admin review modal
 * (Step 7) — same preview, different surrounding chrome.
 */
export default function DesignProductPreview({
  designId,
  category,
  previewImageUrl,
  brewedImageUrl,
  brewedImageAlt,
  backPreviewImageUrl,
  garmentColor,
  showDisclaimer = false,
  onStatus,
}: {
  designId: string;
  category: string;
  /** Admin-only: the downscaled preview-quality version of brewedImageUrl —
   * what a customer actually sees. When given, it's slide 1 (before the
   * full-res brewedImageUrl), so admin reviews customer-view → print-file →
   * mockups in one carousel instead of a separate tiny comparison thumbnail
   * (which read as distorted at small size even when it wasn't). Omitted
   * entirely on the customer-facing usage of this component, which only
   * ever has the preview anyway. */
  previewImageUrl?: string;
  brewedImageUrl: string;
  brewedImageAlt: string;
  /** Locally-composited back print (cheeky text + QR, see back-design.ts) —
   * shown instantly, before PrintRove's async back_mockup is ready. Same
   * transparent-PNG treatment as the front brewed/preview slides. */
  backPreviewImageUrl?: string;
  /** The color this design's art was actually rendered against (Design.
   * variantColor) — the brewed/preview slides are transparent PNGs, so
   * without this they render on a flat neutral background that doesn't
   * match the garment it'll actually print on. Only applied to those two
   * slides; Printrove's mockup slides are already full photos with their
   * own background. */
  garmentColor: string;
  showDisclaimer?: boolean;
  onStatus?: (data: DesignProductDTO) => void;
}) {
  const [data, setData] = useState<DesignProductDTO | null>(null);
  const [slide, setSlide] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Reset transient preview state when the category changes — intentional
    // synchronous reset-on-dependency-change, not state derivable another way.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setData(null);
    setSlide(0);

    async function poll() {
      try {
        const res = await fetch(
          `/api/designs/${designId}/product?category=${encodeURIComponent(category)}`
        );
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          const fallback: DesignProductDTO = {
            status: "failed",
            category,
            color: "Black",
            mockupFrontUrl: null,
            mockupBackUrl: null,
            errorMessage: json.error || "Could not load preview.",
            approvalStatus: "unreviewed",
          };
          setData(fallback);
          onStatus?.(fallback);
          return;
        }
        setData(json);
        onStatus?.(json);
        if (json.status === "pending") {
          timerRef.current = setTimeout(poll, 3000);
        }
      } catch {
        if (cancelled) return;
        const fallback: DesignProductDTO = {
          status: "failed",
          category,
          color: "Black",
          mockupFrontUrl: null,
          mockupBackUrl: null,
          errorMessage: "Could not load preview.",
          approvalStatus: "unreviewed",
        };
        setData(fallback);
        onStatus?.(fallback);
      }
    }
    poll();

    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [designId, category]);

  const labeled = [
    previewImageUrl && { url: previewImageUrl, label: "Customer sees this" },
    { url: brewedImageUrl, label: previewImageUrl ? "Full-res — prints" : undefined },
    backPreviewImageUrl && { url: backPreviewImageUrl, label: "Back" },
    data?.mockupFrontUrl && { url: data.mockupFrontUrl, label: undefined },
    data?.mockupBackUrl && { url: data.mockupBackUrl, label: undefined },
  ].filter((s): s is { url: string; label: string | undefined } => Boolean(s));
  const slides = labeled.map((s) => s.url);
  const current = labeled[slide] ?? labeled[0];
  // The preview/brewed slides (transparent PNGs) need the garment color
  // behind them — the mockup slides are already complete photos.
  const isBrewedSlide =
    current.url === brewedImageUrl || current.url === previewImageUrl || current.url === backPreviewImageUrl;

  return (
    <div>
      <div
        className="relative aspect-[4/5] overflow-hidden rounded-xl bg-paper-2"
        style={isBrewedSlide ? { backgroundColor: getColorCode(garmentColor) } : undefined}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={current.url}
          alt={brewedImageAlt}
          className="h-full w-full object-contain"
        />
        {current.label && (
          <div className="absolute left-2 top-2 rounded-full bg-ink/80 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide text-paper">
            {current.label}
          </div>
        )}
        {data?.status === "pending" && (
          <div className="absolute bottom-2 right-2 flex items-center gap-1.5 rounded-full bg-ink/80 px-2.5 py-1 font-mono text-[10px] text-paper">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> rendering preview…
          </div>
        )}
        {data?.status === "failed" && (
          <div className="absolute bottom-2 right-2 rounded-full bg-pink px-2.5 py-1 font-mono text-[10px] text-paper">
            preview unavailable
          </div>
        )}
      </div>

      {slides.length > 1 && (
        <div className="mt-2 flex justify-center gap-1.5">
          {slides.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setSlide(i)}
              aria-label={`Preview ${i + 1} of ${slides.length}`}
              className={`h-1.5 w-1.5 rounded-full transition-colors ${
                i === slide ? "bg-ink" : "bg-ink-soft/30"
              }`}
            />
          ))}
        </div>
      )}

      {showDisclaimer && (
        <p className="mt-2 text-center font-mono text-[10px] leading-relaxed text-ink-soft">
          Preview is indicative — actual print color, placement, and size may
          vary slightly from what&apos;s shown here.
        </p>
      )}
    </div>
  );
}
