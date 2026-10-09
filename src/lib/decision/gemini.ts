/**
 * Metered Gemini baseline for the spike (arm A). Mirrors the production
 * judge (design-judge.ts judgeDesign / design-judge-bulk.ts
 * defaultStyleReview) — same prompts, schema, model, temperature 0 — but
 * additionally returns latency and token usage, which production does not
 * capture today. Production code is untouched; issue #39 folds the metering
 * back into the real call sites.
 */
import { ai, isTransientProviderError, measureInkLuminance } from "../gemini";
import { prompts } from "@/config/prompts";
import { tokenCost } from "./pricing";
import type { DecisionVerdict, JudgeInput, Metered, ReviewInput, StyleDecision } from "./types";
import type { JudgeFix } from "../design-judge";

/** Production defaults (settings.ts) — deploy.yml sets no GEMINI_*_MODEL override, so prod runs
 * these. Deliberately NOT read from env: a dev .env may pin older models (it does here). */
export const PROD_TEXT_MODEL = "gemini-3.7-flash";
export const PROD_FLASH_LITE_MODEL = "gemini-3.5-flash-lite";

const FIXES: readonly string[] = ["none", "relabel", "invert-ink", "rerun-bg-removal", "regenerate"];

async function meteredGenerate(model: string, parts: unknown[], schema: unknown) {
  const wallStart = performance.now();
  let retries = 0;
  for (;;) {
    const started = performance.now();
    try {
      const res = await ai().models.generateContent({
        model,
        contents: [{ role: "user", parts: parts as never }],
        config: { responseMimeType: "application/json", responseSchema: schema as Record<string, unknown>, temperature: 0 },
      });
      const latencyMs = performance.now() - started;
      const inputTokens = res.usageMetadata?.promptTokenCount ?? 0;
      // Thinking tokens are billed as output on Gemini.
      const outputTokens = (res.usageMetadata?.candidatesTokenCount ?? 0) + (res.usageMetadata?.thoughtsTokenCount ?? 0);
      return { text: res.text, latencyMs, inputTokens, outputTokens, retries, wallMs: performance.now() - wallStart };
    } catch (err) {
      // Production has no in-process retry (Cloud Tasks redelivers); the harness retries so a
      // provider 503 doesn't erase the quality sample, and records how often it happened.
      if (retries < 6 && isTransientProviderError(err)) {
        retries++;
        await new Promise((r) => setTimeout(r, Math.min(30_000, 2000 * 2 ** (retries - 1))));
        continue;
      }
      throw err;
    }
  }
}

export async function geminiJudge(input: JudgeInput, model = PROD_TEXT_MODEL): Promise<Metered<DecisionVerdict>> {
  const meter = { provider: "gemini", model, latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  try {
    // Same grounding as production: real pixels measured with sharp, direction computed in TS.
    const lum = await measureInkLuminance(input.imageB64);
    const hint =
      lum === null
        ? "no non-transparent ink pixels were found in the artwork"
        : (() => {
            const reads = lum > 127.5 ? "light" : "dark";
            const wants = input.claimedColor === "Black" ? "light" : "dark";
            return `measured ${lum.toFixed(1)}/255 -> reads as ${reads} ink; claimed color is ${input.claimedColor}, which needs ${wants} ink; this ${reads === wants ? "MATCHES" : "MISMATCHES"} the claimed color's needed ink direction.`;
          })();
    const prompt = prompts.imageReview(input, input.claimedColor, hint, input.style);
    const r = await meteredGenerate(
      model,
      [{ text: prompt }, { inlineData: { mimeType: "image/png", data: input.imageB64 } }],
      prompts.imageReviewSchema
    );
    Object.assign(meter, { latencyMs: r.latencyMs, inputTokens: r.inputTokens, outputTokens: r.outputTokens, retries: r.retries, wallMs: r.wallMs });
    meter.costUsd = tokenCost(model, r.inputTokens, r.outputTokens);
    if (!r.text) return { value: null, meter, error: "no text" };
    const parsed = JSON.parse(r.text) as Record<string, unknown>;
    const issues = Array.isArray(parsed.issues) ? parsed.issues.filter((i): i is string => typeof i === "string") : [];
    const usable = typeof parsed.usable === "boolean" ? parsed.usable : issues.length === 0;
    const needsRegeneration = typeof parsed.needsRegeneration === "boolean" ? parsed.needsRegeneration : !usable;
    const colorMatchesArt = typeof parsed.colorMatchesArt === "boolean" ? parsed.colorMatchesArt : true;
    const fix = (typeof parsed.fix === "string" && FIXES.includes(parsed.fix) ? parsed.fix : needsRegeneration ? "regenerate" : colorMatchesArt ? "none" : "relabel") as JudgeFix;
    return { value: { usable, colorMatchesArt, needsRegeneration, fix, issues }, meter };
  } catch (err) {
    return { value: null, meter, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function geminiStyleReview(input: ReviewInput, model = PROD_TEXT_MODEL): Promise<Metered<StyleDecision>> {
  const meter = { provider: "gemini", model, latencyMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  try {
    const r = await meteredGenerate(model, [{ text: prompts.styleAlignmentReview(input) }], prompts.styleAlignmentSchema);
    Object.assign(meter, { latencyMs: r.latencyMs, inputTokens: r.inputTokens, outputTokens: r.outputTokens, retries: r.retries, wallMs: r.wallMs });
    meter.costUsd = tokenCost(model, r.inputTokens, r.outputTokens);
    if (!r.text) return { value: null, meter, error: "no text" };
    const parsed = JSON.parse(r.text) as Record<string, unknown>;
    const violations = Array.isArray(parsed.violations) ? parsed.violations.filter((v): v is string => typeof v === "string") : [];
    const aligned = typeof parsed.aligned === "boolean" ? parsed.aligned : violations.length === 0;
    return { value: { aligned, violations }, meter };
  } catch (err) {
    return { value: null, meter, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Cheap one-line vision caption for the Jev hybrid arm (B2). */
export async function geminiCaption(imageB64: string, model = PROD_FLASH_LITE_MODEL) {
  const started = performance.now();
  const res = await ai().models.generateContent({
    model,
    contents: [
      {
        role: "user",
        parts: [
          {
            text: "Describe this t-shirt print graphic in at most two sentences: what is drawn, and transcribe any text exactly. Explicitly say if a t-shirt, collar, sleeve or other garment shape is drawn. Say if the background is a solid color.",
          },
          { inlineData: { mimeType: "image/png", data: imageB64 } },
        ],
      },
    ],
    config: { temperature: 0, maxOutputTokens: 200 },
  });
  const latencyMs = performance.now() - started;
  const inputTokens = res.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = (res.usageMetadata?.candidatesTokenCount ?? 0) + (res.usageMetadata?.thoughtsTokenCount ?? 0);
  return { caption: res.text ?? "", latencyMs, costUsd: tokenCost(model, inputTokens, outputTokens) };
}
