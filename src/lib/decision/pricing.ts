/**
 * Price table for the spike. Values are USD per 1M tokens and were read from
 * the vendors' pricing pages on the date noted — re-verify before trusting a
 * report generated later (see docs/spike-system-one-decision-models.md).
 */
export interface Price {
  inputPerM: number;
  outputPerM: number;
  asOf: string;
  source: string;
}

export const PRICES: Record<string, Price> = {
  // Introductory pricing through 2026-12-31; list price doubles on 2027-01-01 (input $1.50, output $7.50).
  "gemini-3.7-flash": { inputPerM: 0.75, outputPerM: 3.75, asOf: "2026-10-08", source: "https://ai.google.dev/gemini-api/docs/pricing" },
  "gemini-3.8-flash": { inputPerM: 0.75, outputPerM: 3.75, asOf: "2026-10-08", source: "https://ai.google.dev/gemini-api/docs/pricing" },
  "gemini-3.5-flash-lite": { inputPerM: 0.3, outputPerM: 2.5, asOf: "2026-10-08", source: "https://ai.google.dev/gemini-api/docs/pricing" },
  "jev-1.13.0": { inputPerM: 0.042, outputPerM: 0, asOf: "2026-10-08", source: "https://docs.typesafe.ai/models" },
};

export function tokenCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICES[model];
  if (!p) return NaN;
  return (inputTokens * p.inputPerM + outputTokens * p.outputPerM) / 1_000_000;
}
