import { Check, Clock } from "lucide-react";

/**
 * Shown on pre-brewed match cards on the brew page — tells a customer
 * whether this exact (design, color) has already cleared admin review, or
 * is still waiting on one. DesignProduct.approvalStatus already gates real
 * fulfillment either way (see design-product-review.ts), so picking a
 * "Pending Taste-Test" match is exactly as safe as picking a freshly
 * brewed design that hasn't been reviewed yet — this badge is purely
 * informational, not a purchase gate.
 */
export default function ReviewBadge({ status }: { status: "taste-tested" | "pending-taste-test" }) {
  if (status === "taste-tested") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-tea px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-paper">
        <Check className="h-3 w-3" aria-hidden /> Taste-Tested
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-ink/70 px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-paper"
      title="New brews get a quick taste-test by our team before your order ships — usually within a day."
    >
      <Clock className="h-3 w-3" aria-hidden /> Pending Taste-Test
    </span>
  );
}
