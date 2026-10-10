import type { DecisionVerdict, Metered } from "../../src/lib/decision/types";
import type { Fixture } from "./fixtures";

export function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function latencyStats(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  return { n: s.length, mean, p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99) };
}

export interface ArmRow {
  fixtureId: string;
  kind: string;
  color: string;
  result: Metered<DecisionVerdict>;
}

/** Accuracy against fixture ground truth. false-validate = judged usable but truth is unusable (the costly failure). */
export function scoreArm(rows: ArmRow[], fixtures: Map<string, Fixture>) {
  let n = 0, usableOk = 0, colorOk = 0, bothOk = 0, errors = 0;
  let badTotal = 0, falseValidate = 0, goodTotal = 0, falseReject = 0;
  for (const r of rows) {
    const f = fixtures.get(r.fixtureId)!;
    if (!r.result.value) {
      errors++;
      continue;
    }
    n++;
    const v = r.result.value;
    const u = v.usable === f.truth.usable;
    const c = v.colorMatchesArt === f.truth.colorMatchesArt;
    if (u) usableOk++;
    if (c) colorOk++;
    if (u && c) bothOk++;
    if (!f.truth.usable) {
      badTotal++;
      if (v.usable) falseValidate++;
    } else {
      goodTotal++;
      if (!v.usable) falseReject++;
    }
  }
  const frac = (a: number, b: number) => (b ? a / b : NaN);
  return {
    n,
    errors,
    usableAcc: frac(usableOk, n),
    colorAcc: frac(colorOk, n),
    bothAcc: frac(bothOk, n),
    falseValidateRate: frac(falseValidate, badTotal),
    falseRejectRate: frac(falseReject, goodTotal),
  };
}

/** Per-attribute accuracy for Jev arms (signals are probabilities). */
export function attributeAccuracy(rows: ArmRow[], fixtures: Map<string, Fixture>) {
  const map: Record<string, keyof Fixture["truth"]> = {
    garment_drawn: "garmentDrawn",
    opaque_background: "opaqueBackground",
    cropped: "cropped",
    phrase_correct: "phraseCorrect",
    ink_light: "inkLight",
  };
  const out: Record<string, { n: number; acc: number }> = {};
  for (const [q, t] of Object.entries(map)) {
    let n = 0, ok = 0;
    for (const r of rows) {
      const p = r.result.value?.signals?.[q];
      if (p === undefined) continue;
      n++;
      if (p > 0.5 === fixtures.get(r.fixtureId)!.truth[t]) ok++;
    }
    out[q] = { n, acc: n ? ok / n : NaN };
  }
  return out;
}

export function sum(rows: ArmRow[], f: (m: Metered<DecisionVerdict>["meter"]) => number): number {
  return rows.reduce((a, r) => a + (f(r.result.meter) || 0), 0);
}

export function pctGain(baseline: number, arm: number): number {
  return baseline ? ((baseline - arm) / baseline) * 100 : NaN;
}

/** Cohen's kappa for two boolean label vectors of equal length. */
export function kappa(a: boolean[], b: boolean[]): number {
  const n = a.length;
  if (n === 0) return NaN;
  let agree = 0, aT = 0, bT = 0;
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) agree++;
    if (a[i]) aT++;
    if (b[i]) bT++;
  }
  const po = agree / n;
  const pe = (aT / n) * (bT / n) + (1 - aT / n) * (1 - bT / n);
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}
