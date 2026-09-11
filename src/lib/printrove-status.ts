// The ONLY place a raw Printrove order-status string gets interpreted.
// Everything downstream (order-status.ts, /api/account/orders, OrderCard)
// works off the simplified value, so correcting a wrong mapping here is a
// one-file change.
//
// Confirmed live (via scripts/test-order-status.ts) for one real merchant-
// cancelled order: raw status "Cancelled". The rest of the table below is
// still unvalidated placeholder guesses — re-run that script against a real
// order as it reaches each stage (shipped/delivered) and correct the keys
// to match what actually comes back. Until then, an unrecognized raw value
// still falls back to "printing" (the safe unknown-value default) — never
// wrong in the direction of claiming delivered/dispatched/cancelled
// prematurely.
export type LivePrintroveStatus = "printing" | "dispatched" | "out_for_delivery" | "delivered" | "cancelled";

const RAW_TO_SIMPLIFIED: Record<string, LivePrintroveStatus> = {
  // placeholder guesses — REPLACE once scripts/test-order-status.ts has run
  // against a real order and the actual raw status strings are known.
  pending: "printing",
  processing: "printing",
  printing: "printing",
  in_production: "printing",
  shipped: "dispatched",
  dispatched: "dispatched",
  out_for_delivery: "out_for_delivery",
  delivered: "delivered",
  completed: "delivered",
  // Confirmed live.
  cancelled: "cancelled",
  canceled: "cancelled",
};

export function mapPrintroveStatus(raw: string | null | undefined): LivePrintroveStatus {
  if (!raw) return "printing";
  return RAW_TO_SIMPLIFIED[raw.toLowerCase().trim()] ?? "printing";
}
