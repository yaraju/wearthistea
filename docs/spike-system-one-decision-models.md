# Spike: Jev (System One) and Gemini model choices for cost, latency and yield

Branch `spike/system-one-decision-models` · issues #39, #40, #41 · run 2026-10-08/09.
Scope per owner: hosted Jev only (no self-hosted GPU models), no market-appeal work, focus on cost and shippable changes in the current flow. Read-only access to the prod DB and GCS was approved (no writes were made).

## Bottom line

1. **Swap the front-art image model to `gemini-nano-banana-2.1`.** This is where nearly all the money is: images are ~97% of per-design cost. Measured: $0.059 vs $0.140 per render (-58%), same ~23 s latency, and fewer judge-flagged structural defects (40% vs 67%, n=30 each). Modelled cost per accepted design: **$0.44 -> $0.11 (-75%)**, per 5-concept keyword **$1.23 -> $0.46**.
2. **Add model fallback for 503/429** (shipped in code, off until a backup model is set): retry the primary once, then `GEMINI_IMAGE_BACKUP_MODEL` (suggested `gemini-3.1-flash-lite-image`). No 503s occurred in my 130+ image calls, so the real-outage benefit is **unproven**; the logic is unit-tested with simulated errors.
3. **Use Jev only for text-only decisions.** Shipped behind flags: a pre-render keyword gate (`DECISION_GATE`, default off). Jev matched Gemini 100% on my labeled sets, was 76-95% faster and 90%+ cheaper per call, but the absolute dollars are tiny (fractions of a cent per call). Value is safety and speed, not savings.
4. **Do not use Jev to judge generated art.** It cannot see images; fed measurements, captions or vectorized SVG it was not viable on real art (details below). Keep Gemini vision for the image judge.
5. **Keep `gemini-3.7-flash` as the judge; skip `gemini-3.8-flash`.** 95% agreement (kappa 0.87), same latency, ~32% more output tokens (+24% cost on 60 images).
6. **Not worth shipping:** the "flat green background" prompt (no measurable gain over the model swap) and the svg-style arm (inconclusive, see Limitations).

## What the current flow costs (measured / modelled)

Per keyword: 5 concepts (flash-lite, ~free) -> 5 image renders -> judge each -> programmatic fix or one regeneration.
Production first-pass quality is poor: on a random sample of **60 real prod designs** judged with the production judge, **72% have a structural defect** (fake transparency checkerboard baked into the art ~50%, phrase/extra-text ~30%, garment drawn into the art ~8%); I viewed samples of each class and the judge was right. Colour/ink mismatch is another ~50% but is fixed for free by relabel/invert. Only 17 of 493 prod designs have ever been judged, so this has been invisible.

| Config (model, 2026 pricing) | $/render | p50 render | structural defect | $/accepted design | accepted after 1 regen | $/keyword (5) |
|---|---|---|---|---|---|---|
| A current: `gemini-3-pro-image` | 0.140 | 22.5 s | 67% (20/30) | 0.44 | 56% | 1.23 |
| **B `gemini-nano-banana-2.1`** | 0.059 | 23.1 s | 40% (12/30) | **0.11 (-75%)** | 84% | **0.46 (-63%)** |
| D `gemini-3.1-flash-lite-image` | 0.034 | **5.2 s (-77%)** | 82% (9/11) | 0.22 | 33% | 0.37 |

Model: `scripts/spike/cost-model.ts` (render + judge + at most one regeneration, colour-only fixes free but re-judged). With the 2027-01-01 doubling of text list prices the A->B saving is unchanged at -74%. Caveats: the 20/30 vs 12/30 gap is significant at roughly p=0.04 but n is small; lite is fast and cheap per image but yields too many defects to use as primary (text duplicated, backgrounds); it is a reasonable emergency backup. Side-by-side images (`spike-results/compare.png`) also show nano-banana-2.1 following the concept better in the cases I looked at (pro drew a TV for "microwave").

## Jev findings (all hosted, `jev-1.13.0`, $0.042/M input tokens)

| Test | Result |
|---|---|
| Keyword gate, 53 labeled keywords (28 allow incl. celebrity tea, 25 block: injection, private-person harassment, hate, sexual/minors, self-harm, threats, illegal, gibberish) | Jev 100%, Gemini flash-lite 100%. Jev p50 300 ms vs 1,254 ms (-76%); $0.000023 vs $0.00028 per call (-92%). Threshold 0.2-0.7 all perfect; 0.1 falsely blocked ~7%. Default 0.5. Clear-cut set: harder borderline cases are untested |
| Style/concept review, 36 labeled concepts x3 | Both 100%. p50 6.0 s -> 0.32 s (-95%), $0.0029 -> $0.00005 per call (-98%). Admin/bulk path only, so tiny dollars |
| Judge on synthetic native SVG fixtures (24) | Phrase 100%, ink colour 100%, opaque background 100%, garment 92%, cropped 83%. Proves Jev can read SVG for explicit attributes |
| Judge on **real generated art** (30 designs, 60 judgments) | Not viable: features-only colour accuracy 28% (misreads numeric luminance), caption-assisted 35%, vectorized-SVG arm HTTP 400 `max_tokens_exceeded` on 20/60 (46-50K-char SVGs) and 73% colour accuracy. Gemini vision stays |

Jev is a good fit where the input is text and the answer is a typed decision (screening, classification, rule checks); it is not a prompt writer and cannot see images. The "pre-plan prompts with Jev" idea was deprioritised: after the model swap, the dominant remaining defects are image-model rendering artifacts, not prompt-planning gaps, and the one prompt change I tested (green background) did not help.

## 503 / availability notes

- 0 503/429 in ~140 calls in this window; earlier runs (the judge on `gemini-3.7-flash`) did hit 503 "high demand" (17 of 24 calls in one pilot), p95 judge latency 36-45 s.
- **Prod has no retry or fallback for Gemini errors** (Cloud Tasks redelivery only). New `src/lib/gemini-resilient.ts` wraps image generate/edit and the judge: retry primary once with jitter on 429/500/503/504, then backup model if configured. 402 (billing) and 4xx are not retried.
- **Billing risk observed in prod data and in this spike:** Gemini returns `402 RESOURCE_EXHAUSTED "prepayment credits are depleted"`. Prod judge rows already carry this error, and my own runs hit it mid-spike. A different model on the same key will not help; set a billing alert/auto top-up.

## What shipped in this branch

| Change | Where | Default |
|---|---|---|
| Model fallback wrapper + wiring | `src/lib/gemini-resilient.ts`, `gemini.ts` (generateImage/generateImageEdit), `design-judge.ts` | inert until `GEMINI_IMAGE_BACKUP_MODEL` / `GEMINI_TEXT_BACKUP_MODEL` set |
| Keyword gate (Jev, fail-open, parallel with concept writing) | `src/lib/decision/gate.ts`, `src/app/api/generate/route.ts` | `DECISION_GATE=off` |
| Decision adapters, features, pricing | `src/lib/decision/*` | not on any prod path |
| Spike harness | `scripts/spike-system-one.ts`, `scripts/spike/*` | dev only; results in gitignored `spike-results/` |
| Tests | `scripts/test-gemini-resilient.ts` (9), `scripts/test-decision-gate.ts` (10), no network | pass |
| Env docs | `.env.example` | n/a |

**Not changed (needs owner decision):** default model env values and `.github/workflows/deploy.yml` (adding `TYPESAFE_API_KEY`, `DECISION_GATE`). Env names matter: the render model that sets cost is **`GEMINI_IMAGEN_FAST_MODEL`** (default `gemini-3-pro-image`), not `GEMINI_IMAGE_MODEL` (only edits / un-overridden calls). The judge model env is `GEMINI_TEXT_MODEL`, not `GEMINI_MODEL`. Local `.env` pins old `gemini-2.5-*` models, so local dev differs from prod.

## Rollout plan

1. Set on Cloud Run: `GEMINI_IMAGEN_FAST_MODEL=gemini-nano-banana-2.1`, `GEMINI_IMAGE_MODEL=gemini-nano-banana-2.1`, `GEMINI_IMAGE_BACKUP_MODEL=gemini-3.1-flash-lite-image`. Watch Langfuse `generateImage` spans (`servedBy` is recorded) and the judge pass rate for a week. Rollback = set `GEMINI_IMAGEN_FAST_MODEL=gemini-3-pro-image`.
2. Add `TYPESAFE_API_KEY` secret, set `DECISION_GATE=shadow` for 1-2 weeks, review the `[Stage 1] keyword gate` log lines and Langfuse `keyword-gate` events for would-block rate and false positives, then `enforce`.
3. Optional follow-ups: swap `defaultStyleReview` to Jev (admin-only); add Langfuse spans/cost for judge and embedding calls (none today); billing alert for 402.

## Limitations

- Small samples (n=30 per image arm, 53 gate cases, 36 style cases); labeled sets are mostly clear-cut. Differences under ~15-20 points are not proof.
- "Defect" rates come from the Gemini judge, which cannot see alpha; I verified the defect classes by viewing images but did not hand-label every row. Prod sample was random from `status=generated` rows with a colour, all with `gemini-3-pro-image`-era art.
- Cost model assumes defect rate = regeneration rate and a regeneration cap of one; concept-call cost is an estimate.
- svg-style (art-only + deterministic phrase band) arm: only 18 of 30 completed before the Gemini credits ran out (402); the completed ones showed phrase-band defects, so it is **inconclusive**, not rejected.
- No real 503 outage was observed on the new models; fallback quality under a mid-batch switch (mixed styles in one batch) is untested.
- Vendor claims (Jev "40-200x faster") are not used; all numbers above are measured here, from a laptop on one network path.
