// The ONLY place a raw Printrove order-status string gets interpreted.
// Everything downstream (order-status.ts, /api/account/orders, OrderCard)
// works off the simplified value, so correcting a wrong mapping here is a
// one-file change.
//
// UNVALIDATED as of writing this: no order in this database has ever
// reached status "published" (confirmed by querying the DB directly), so
// there is no real Printrove response to test this lookup table against
// yet. Run `npx tsx scripts/test-order-status.ts <printroveOrderId>` the
// first time a real order ships, and correct the keys below to match what
// actually comes back — until then, every "published" order will render as
// "printing" (the safe unknown-value default), which is misleading once an
// order has actually shipped but harmless (never wrong in the other
// direction — it never claims delivered/dispatched prematurely).
export type LivePrintroveStatus = "printing" | "dispatched" | "out_for_delivery" | "delivered";

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
};

export function mapPrintroveStatus(raw: string | null | undefined): LivePrintroveStatus {
  if (!raw) return "printing";
  return RAW_TO_SIMPLIFIED[raw.toLowerCase().trim()] ?? "printing";
}
