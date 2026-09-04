"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { DesignProductDTO } from "@/lib/types";

/**
 * Polls GET /api/designs/[id]/product?category=X and renders a carousel:
 * the already-brewed AI art first, then the real Printrove mockup(s) once
 * ready. Shared by the customer pick-time modal and the admin review modal
 * (Step 7) — same preview, different surrounding chrome.
 */
export default function DesignProductPreview({
  designId,
  category,
  brewedImageUrl,
  brewedImageAlt,
  showDisclaimer = false,
  onStatus,
}: {
  designId: string;
  category: string;
  brewedImageUrl: string;
  brewedImageAlt: string;
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

  const slides = [brewedImageUrl, data?.mockupFrontUrl, data?.mockupBackUrl].filter(
    (s): s is string => Boolean(s)
  );
  const current = slides[slide] ?? brewedImageUrl;

  return (
    <div>
      <div className="relative aspect-[4/5] overflow-hidden rounded-xl bg-paper-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={current}
          alt={brewedImageAlt}
          className="h-full w-full object-contain"
        />
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
