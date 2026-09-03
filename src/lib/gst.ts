/** Post-GST-2.0 (Sept 2025) apparel slab: 5% at/under ₹2,500/piece, 18% above. */
export function gstRateFor(unitPrice: number): number {
  return unitPrice <= 2500 ? 0.05 : 0.18;
}

export interface GstBreakdown {
  unitPrice: number;
  quantity: number;
  totalInclusive: number;
  taxableValue: number;
  gstRate: number;
  gstAmount: number;
  /** true = buyer and seller are in the same state (CGST+SGST); false = IGST. */
  intraState: boolean;
  cgst: number;
  sgst: number;
  igst: number;
}

/** unitPrice is GST-inclusive (what the customer actually pays per item) —
 * taxable value is back-calculated, never added on top. */
export function computeGst(
  unitPrice: number,
  quantity: number,
  buyerState: string | null,
  sellerState: string
): GstBreakdown {
  const gstRate = gstRateFor(unitPrice);
  const totalInclusive = unitPrice * quantity;
  const taxableValue = totalInclusive / (1 + gstRate);
  const gstAmount = totalInclusive - taxableValue;

  // Buyer state unknown: can't confirm place of supply, so don't silently
  // guess intra-state — that's the branch that halves the rate per line,
  // and the wrong guess understates tax due. Treat as inter-state.
  const intraState = Boolean(
    buyerState && buyerState.trim().toLowerCase() === sellerState.trim().toLowerCase()
  );

  return {
    unitPrice,
    quantity,
    totalInclusive,
    taxableValue,
    gstRate,
    gstAmount,
    intraState,
    cgst: intraState ? gstAmount / 2 : 0,
    sgst: intraState ? gstAmount / 2 : 0,
    igst: intraState ? 0 : gstAmount,
  };
}
