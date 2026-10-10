/**
 * TypeSafe Jev (System One) decision adapter. Jev is a hosted, text-only
 * model: it takes a `state` string plus typed questions (noul = yes/no
 * probability, choice = one of N) and returns calibrated answers in one
 * parallel pass, with no generated text. Docs: https://docs.typesafe.ai
 *
 * Three input modes for the image judge (spike arms B1/B2/B3):
 *  - "features": sharp-measured features + concept text only
 *  - "caption":  features + a one-line vision caption produced upstream
 *  - "svg":      the SVG source itself, to test whether Jev can judge from
 *                markup directly
 */
import { tokenCost } from "./pricing";
import type { ImageFeatures } from "./features";
import type { DecisionVerdict, GarmentColor, JudgeInput, Metered, ReviewInput, StyleDecision } from "./types";
import type { JudgeFix } from "../design-judge";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

type Question =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };

interface JevResponse {
  model: string;
  answers: Record<
    string,
    { type: string; noul?: number; choice?: string; confidence?: number; probabilities?: Record<string, number> }
  >;
  usage: { input_tokens: number; output_tokens: number };
}

export async function callJev(state: string, questions: Record<string, Question>, timeoutMs = 20_000) {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error("TYPESAFE_API_KEY is not set.");
  const started = performance.now();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: process.env.TYPESAFE_MODEL ?? "jev-latest", state, questions }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const latencyMs = performance.now() - started;
  if (!res.ok) {
    throw Object.assign(new Error(`Jev HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`), { status: res.status });
  }
  const body = (await res.json()) as JevResponse;
  return { body, latencyMs };
}

export type JevJudgeMode = "features" | "caption" | "svg";

const NOUL = (instructions: string): Question => ({ type: "noul", instructions });

function judgeQuestions(mode: JevJudgeMode): Record<string, Question> {
  const src =
    mode === "svg"
      ? "the SVG source in `svg`"
      : mode === "caption"
        ? "the `measurements` and `caption` fields"
        : "the `measurements` fields";
  return {
    garment_drawn: NOUL(
      `Using ${src}: is an actual t-shirt, garment, collar or sleeve silhouette drawn as part of the print artwork (not just a simple graphic icon plus text)?`
    ),
    opaque_background: NOUL(
      `Using ${src}: does the artwork have an opaque background that fills the whole canvas (instead of a transparent background with only the art and text painted)?`
    ),
    cropped: NOUL(`Using ${src}: is any art or text cut off by or extending beyond the canvas edge?`),
    phrase_correct: NOUL(
      `Using ${src}: does the visible text read exactly the expected phrase \`expectedPhrase\` (no misspelling, no extra text)?`
    ),
    ink_light: NOUL(`Using ${src}: is the ink (fill color of the art and text) light, closer to white than to black?`),
  };
}

/** Pure mapping from Jev answers to the production verdict shape. */
export function verdictFromAnswers(
  answers: JevResponse["answers"],
  claimedColor: GarmentColor,
  style: "raster" | "svg"
): DecisionVerdict {
  const p = (k: string) => answers[k]?.noul ?? 0.5;
  const garment = p("garment_drawn") > 0.5;
  const opaque = p("opaque_background") > 0.5;
  const cropped = p("cropped") > 0.5;
  const phraseOk = p("phrase_correct") > 0.5;
  const inkLight = p("ink_light") > 0.5;
  const colorMatchesArt = inkLight === (claimedColor === "Black");
  const issues: string[] = [];
  if (garment) issues.push("garment/mockup silhouette drawn into the print graphic");
  if (opaque) issues.push("background is not transparent");
  if (cropped) issues.push("important art is cropped");
  if (!phraseOk) issues.push("phrase is misspelled, missing or has extra text");
  const usable = !(garment || opaque || cropped || !phraseOk);
  let fix: JudgeFix = "none";
  if (garment || cropped || !phraseOk) fix = "regenerate";
  else if (opaque) fix = "rerun-bg-removal";
  else if (!colorMatchesArt) fix = style === "svg" ? "invert-ink" : "relabel";
  const signals = Object.fromEntries(Object.keys(answers).map((k) => [k, p(k)]));
  return { usable, colorMatchesArt, needsRegeneration: fix === "regenerate", fix, issues, signals };
}

export async function jevJudge(
  input: JudgeInput,
  mode: JevJudgeMode,
  extra: { features?: ImageFeatures; caption?: string; prepLatencyMs?: number; prepCostUsd?: number } = {}
): Promise<Metered<DecisionVerdict>> {
  const stateObj: Record<string, unknown> = {
    task: "Print-production QA for a t-shirt graphic. The art is printed on the claimed garment color.",
    claimedGarmentColor: input.claimedColor,
    expectedPhrase: input.phrase,
    expectedVisual: input.visualConcept,
  };
  if (mode === "svg") stateObj.svg = input.svg;
  else stateObj.measurements = extra.features;
  if (mode === "caption") stateObj.caption = extra.caption;

  const meter = {
    provider: `jev-${mode}`,
    model: "jev",
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    prepLatencyMs: extra.prepLatencyMs,
    prepCostUsd: extra.prepCostUsd,
  };
  try {
    const { body, latencyMs } = await callJev(JSON.stringify(stateObj), judgeQuestions(mode));
    meter.model = body.model;
    meter.latencyMs = latencyMs;
    meter.inputTokens = body.usage.input_tokens;
    meter.outputTokens = body.usage.output_tokens;
    meter.costUsd = tokenCost(body.model, body.usage.input_tokens, body.usage.output_tokens);
    return { value: verdictFromAnswers(body.answers, input.claimedColor, input.style), meter };
  } catch (err) {
    return { value: null, meter, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Style-alignment decision (text-only: Jev's natural fit). */
export async function jevStyleReview(input: ReviewInput, rulesText: string): Promise<Metered<StyleDecision>> {
  const state = JSON.stringify({
    task: "Re-validate an already-generated t-shirt concept against the brand rules.",
    rules: rulesText,
    phrase: input.phrase,
    visualConcept: input.visualConcept,
    backPhrase: input.backPhrase ?? null,
  });
  const questions: Record<string, Question> = {
    violates_rules: NOUL(
      "Does the concept (phrase, visualConcept, backPhrase) violate ANY rule in `rules`, e.g. phrase too long or not punchy, emojis/hashtags/non-ASCII, copied lyrics/slogans/memes, real names, a visualConcept that is not concretely drawable, or a backPhrase that merely repeats the front phrase?"
    ),
  };
  const meter = { provider: "jev-text", model: "jev", latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  try {
    const { body, latencyMs } = await callJev(state, questions);
    meter.model = body.model;
    meter.latencyMs = latencyMs;
    meter.inputTokens = body.usage.input_tokens;
    meter.outputTokens = body.usage.output_tokens;
    meter.costUsd = tokenCost(body.model, body.usage.input_tokens, body.usage.output_tokens);
    const v = body.answers.violates_rules?.noul ?? 0.5;
    return {
      value: { aligned: v <= 0.5, violations: v > 0.5 ? ["flagged by Jev"] : [], signals: { violates_rules: v } },
      meter,
    };
  } catch (err) {
    return { value: null, meter, error: err instanceof Error ? err.message : String(err) };
  }
}
