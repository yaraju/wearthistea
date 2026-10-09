/**
 * X0: image-model matrix. Same concepts, same production prompt
 * (prompts.designImage) and post-processing (removeBgB64 + resolveGarmentColor),
 * across image models, each output judged by the production judge. Logs every
 * attempt's HTTP status so 503/429 rates per model are measured, and runs the
 * retry-then-backup chain the ship plan proposes.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ArtItem } from "./gen-art";

export interface Attempt {
  model: string;
  ok: boolean;
  status?: number;
  ms: number;
  error?: string;
}

/** USD per generated image by output size tier, from ai.google.dev/gemini-api/docs/pricing (2026-10-07). */
const IMAGE_PRICE: Record<string, { "1K": number; "2K": number; "4K": number; inPerM: number; textOutPerM: number }> = {
  "gemini-3-pro-image": { "1K": 0.134, "2K": 0.134, "4K": 0.24, inPerM: 2.0, textOutPerM: 12 },
  "gemini-nano-banana-2.1": { "1K": 0.0336, "2K": 0.0504, "4K": 0.113, inPerM: 1.5, textOutPerM: 7.5 },
  "gemini-3.1-flash-lite-image": { "1K": 0.0336, "2K": 0.0336, "4K": 0.0336, inPerM: 0.25, textOutPerM: 1.5 },
};

function tier(w: number, h: number): "1K" | "2K" | "4K" {
  const m = Math.max(w, h);
  return m <= 1100 ? "1K" : m <= 2100 ? "2K" : "4K";
}

export interface ImageResult {
  conceptId: string;
  model: string; // arm label (primary model)
  servedBy: string | null; // model that actually produced the image
  attempts: Attempt[];
  fellBack: boolean;
  wallMs: number;
  width?: number;
  height?: number;
  costUsd?: number;
  resolved?: "Black" | "White";
  file?: string;
  error?: string;
}

const status = (e: unknown): number | undefined => (e as { status?: number } | null)?.status;
const isTransient = (e: unknown) => [429, 500, 503, 504].includes(status(e) ?? 0);

/** Retry primary once (jittered) on transient errors, then fall back to the backup model. */
export async function callWithFallback<T>(
  primary: string,
  backup: string | null,
  run: (model: string) => Promise<T>,
  attempts: Attempt[],
  retryDelayMs = 1500
): Promise<{ value: T; servedBy: string }> {
  const plan: string[] = [primary, primary, ...(backup ? [backup] : [])];
  let lastErr: unknown;
  for (let i = 0; i < plan.length; i++) {
    const model = plan[i];
    const started = performance.now();
    try {
      const value = await run(model);
      attempts.push({ model, ok: true, ms: performance.now() - started });
      return { value, servedBy: model };
    } catch (err) {
      attempts.push({ model, ok: false, status: status(err), ms: performance.now() - started, error: String(err instanceof Error ? err.message : err).slice(0, 160) });
      lastErr = err;
      if (!isTransient(err)) break;
      if (i === 0) await new Promise((r) => setTimeout(r, retryDelayMs * (0.5 + Math.random())));
    }
  }
  throw lastErr;
}

/** Variant K: models cannot output real alpha and paint a fake checkerboard "transparency" grid into the art
 * (the #1 prod defect). Ask for a flat key-colored background instead; the existing imgly removal then strips it. */
const KEY_OVERRIDE = `

BACKGROUND OVERRIDE (supersedes every earlier mention of "transparent"): you cannot output real transparency, so
paint the background as ONE perfectly flat, solid pure green (#00FF00) fill edge to edge, a color that appears nowhere
in the artwork itself. NEVER draw a checkerboard, grid, or any "transparency" pattern, and no gradient, shadow, glow
or texture on the background. A separate process removes the green afterward.`;

export async function renderWithModel(
  concept: ArtItem,
  model: string,
  backup: string | null,
  outDir: string,
  variant: "control" | "key" | "svg" = "control"
): Promise<ImageResult> {
  const { ai, resolveGarmentColor } = await import("../../src/lib/gemini");
  const { prompts } = await import("../../src/config/prompts");
  const { removeBgB64 } = await import("../../src/lib/background-removal");
  const sharp = (await import("sharp")).default;

  const conceptObj = {
    title: concept.phrase,
    phrase: concept.phrase,
    visualConcept: concept.visualConcept,
    vibe: "",
    backPhrase: concept.backPhrase ?? "",
    artStyle: variant === "svg" ? "svg" : "raster",
  } as never;
  const basePrompt = variant === "svg" ? prompts.designImageArtOnly(conceptObj) : prompts.designImage(conceptObj);
  const prompt = variant === "key" ? basePrompt + KEY_OVERRIDE : basePrompt;
  const attempts: Attempt[] = [];
  const wallStart = performance.now();
  const out: ImageResult = { conceptId: concept.id, model, servedBy: null, attempts, fellBack: false, wallMs: 0 };
  try {
    const { value, servedBy } = await callWithFallback(
      model,
      backup,
      async (m) => {
        const res = await ai().models.generateContent({
          model: m,
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          config: { responseModalities: ["TEXT", "IMAGE"] },
        });
        const parts = res.candidates?.[0]?.content?.parts ?? [];
        let b64: string | undefined;
        let text = "";
        for (const p of parts) {
          if (p.inlineData?.data && !b64) b64 = p.inlineData.data;
          if (p.text) text += p.text;
        }
        if (!b64) throw new Error(`no image returned by ${m}: ${(text || "").slice(0, 100)}`);
        return { b64, text, inTok: res.usageMetadata?.promptTokenCount ?? 0, textOutTok: res.usageMetadata?.thoughtsTokenCount ?? 0 };
      },
      attempts
    );
    out.servedBy = servedBy;
    out.fellBack = servedBy !== model;
    let b64 = value.b64;
    const meta = await sharp(Buffer.from(b64, "base64")).metadata();
    out.width = meta.width;
    out.height = meta.height;
    const price = IMAGE_PRICE[servedBy];
    out.costUsd = price ? price[tier(meta.width ?? 1024, meta.height ?? 1024)] + (value.inTok * price.inPerM + value.textOutTok * price.textOutPerM) / 1e6 : undefined;
    try {
      b64 = await removeBgB64(b64);
    } catch {
      /* production falls back to raw output */
    }
    out.resolved = await resolveGarmentColor(value.text, b64);
    if (variant === "svg") {
      // Production svg path: phrase is typeset deterministically into the reserved band.
      const { compositePhraseBand, PRINT_CANVAS_WIDTH, PRINT_CANVAS_HEIGHT, PRINT_TEXT_BAND_HEIGHT } = await import("../../src/lib/text-layer");
      b64 = await compositePhraseBand(b64, concept.phrase, {
        canvasWidth: PRINT_CANVAS_WIDTH,
        canvasHeight: PRINT_CANVAS_HEIGHT,
        bandHeight: PRINT_TEXT_BAND_HEIGHT,
        color: out.resolved === "Black" ? "#ffffff" : "#111111",
      });
    }
    mkdirSync(outDir, { recursive: true });
    out.file = `${outDir}/${concept.id}.png`;
    writeFileSync(out.file, Buffer.from(b64, "base64"));
  } catch (err) {
    out.error = String(err instanceof Error ? err.message : err).slice(0, 200);
  }
  out.wallMs = performance.now() - wallStart;
  return out;
}

export function loadConcepts(n: number, offset = 0): ArtItem[] {
  const all: ArtItem[] = JSON.parse(readFileSync("spike-results/art/manifest.json", "utf8"));
  const seen = new Set<string>();
  return all.filter((i) => !i.error && !seen.has(i.phrase) && seen.add(i.phrase)).slice(offset, offset + n);
}
