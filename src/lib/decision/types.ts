/**
 * Decision-provider seam for the System One spike (issue #39). A decision
 * step is judge/classify/route — not creative generation. Each provider
 * returns the SAME verdict shape the production judge already uses
 * (design-judge.ts's JudgeVerdict, minus the sharp-measured luminance which
 * callers add) plus metering so cost/latency can be compared across models.
 */
import type { JudgeFix } from "../design-judge";

export type GarmentColor = "Black" | "White";

export interface DecisionVerdict {
  usable: boolean;
  colorMatchesArt: boolean;
  needsRegeneration: boolean;
  fix: JudgeFix;
  issues: string[];
  /** Per-question probabilities/confidence when the provider exposes them
   * (Jev). Used to test confidence-gated fallback to a stronger model. */
  signals?: Record<string, number>;
}

export interface StyleDecision {
  aligned: boolean;
  violations: string[];
  signals?: Record<string, number>;
}

export interface Metering {
  provider: string;
  model: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  /** Marginal API cost of this call. For self-hosted GPU endpoints this is
   * computed by the harness from GPU-hours, not by the adapter. */
  costUsd: number;
  /** Extra latency/cost from preprocessing stages (caption call, vectorize). */
  /** Transient 429/503 retries the harness had to make before this call succeeded (production makes none). */
  retries?: number;
  /** Wall time including retries/backoff; latencyMs is the successful attempt only. */
  wallMs?: number;
  prepLatencyMs?: number;
  prepCostUsd?: number;
}

export interface Metered<T> {
  value: T | null;
  meter: Metering;
  /** Set when the call failed or the response could not be parsed. */
  error?: string;
}

export interface JudgeInput {
  phrase: string;
  visualConcept: string;
  claimedColor: GarmentColor;
  style: "raster" | "svg";
  imageB64: string;
  /** Native or vectorized SVG source, when the arm consumes SVG. */
  svg?: string;
}

export interface ReviewInput {
  phrase: string;
  visualConcept: string;
  backPhrase?: string | null;
}
