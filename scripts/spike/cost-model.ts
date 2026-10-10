/**
 * X1: per-keyword and per-accepted-design cost/latency model for the current
 * flow vs proposed config, from MEASURED inputs (see docs/spike-system-one-decision-models.md):
 *  - image $/render and p50 latency per model (image-matrix runs, n=30)
 *  - structural-defect rate per model (production judge on those renders)
 *  - judge $/call (prod sample, n=60) and p50 latency
 * Chain modelled on validation-chain.ts: render -> judge; a structural defect
 * triggers ONE regeneration render (+ re-judge); colour-only problems are fixed
 * programmatically for free (relabel / invert-ink) and re-judged once.
 */
export {};

interface Cfg {
  name: string;
  imageUsd: number;
  imageP50s: number;
  structuralDefect: number; // P(judge asks for a regeneration/bg-rerun render)
  judgeUsd: number;
  judgeP50s: number;
}

const CONCEPTS_PER_KEYWORD = 5;
const CONCEPT_CALL_USD = 0.003; // flash-lite, ~1.5K in / ~1K out (estimate, not measured)
const COLOR_ONLY_FIX_RATE = 0.27; // prod sample: colour/ink-only issues (relabel/invert) fixed free but re-judged

function run(c: Cfg, judgeScale = 1) {
  const d = c.structuralDefect;
  const judge = c.judgeUsd * judgeScale;
  // renders per design: 1 + d (one regeneration cap); judge calls: 1 + (d regen re-judge) + colour-fix re-judge
  const renders = 1 + d;
  const judges = 1 + d + COLOR_ONLY_FIX_RATE;
  const cost = renders * c.imageUsd + judges * judge;
  const accepted = 1 - d * d; // survives either first render or its single regeneration
  const seconds = c.imageP50s + c.judgeP50s + d * (c.imageP50s + c.judgeP50s);
  return { cost, accepted, costPerAccepted: cost / accepted, renders, judges, seconds, keywordUsd: CONCEPT_CALL_USD + CONCEPTS_PER_KEYWORD * cost };
}

const CONFIGS: Cfg[] = [
  { name: "A current: gemini-3-pro-image + 3.7-flash judge", imageUsd: 0.1405, imageP50s: 22.5, structuralDefect: 20 / 30, judgeUsd: 0.0054, judgeP50s: 10.1 },
  { name: "B nano-banana-2.1 + 3.7-flash judge", imageUsd: 0.0589, imageP50s: 23.1, structuralDefect: 12 / 30, judgeUsd: 0.0054, judgeP50s: 10.1 },
  { name: "C nano-banana-2.1 + 3.8-flash judge", imageUsd: 0.0589, imageP50s: 23.1, structuralDefect: 12 / 30, judgeUsd: 0.0067, judgeP50s: 10.8 },
  { name: "D lite image (5s) + 3.7-flash judge", imageUsd: 0.0339, imageP50s: 5.2, structuralDefect: 9 / 11, judgeUsd: 0.0054, judgeP50s: 10.1 },
];

const pct = (a: number, b: number) => `${(((b - a) / a) * 100).toFixed(0)}%`;
for (const [label, scale] of [["2026 pricing (judge text $0.75/$3.75 per M)", 1], ["2027-01 text list price (x2)", 2]] as const) {
  console.log(`\n== ${label} ==`);
  const base = run(CONFIGS[0], scale);
  for (const c of CONFIGS) {
    const r = run(c, scale);
    console.log(
      `${c.name.padEnd(52)} $/design ${r.cost.toFixed(3)}  $/accepted ${r.costPerAccepted.toFixed(3)} (${pct(base.costPerAccepted, r.costPerAccepted)})  $/keyword(5) ${r.keywordUsd.toFixed(2)}  accepted ${(r.accepted * 100).toFixed(0)}%  renders ${r.renders.toFixed(2)}  s/design ${r.seconds.toFixed(0)}`
    );
  }
}
console.log("\nJev levers on top of config B ($/design saved, 2026 pricing):");
const b = run(CONFIGS[1]);
console.log(`  bulk style review swap: -$${(0.0029 - 0.00005).toFixed(4)}/call (admin/bulk only)`);
console.log(`  keyword gate vs flash-lite: -$${(0.00028 - 0.000023).toFixed(5)}/request and -${(1254 - 300)}ms p50 (blocked requests also skip ${CONCEPTS_PER_KEYWORD} renders = $${(CONCEPTS_PER_KEYWORD * b.cost).toFixed(2)} each)`);
