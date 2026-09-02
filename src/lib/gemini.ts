import { GoogleGenAI } from "@google/genai";
import { settings } from "@/config/settings";
import { prompts, isDarkGarment, type Concept } from "@/config/prompts";
import { removeBgB64 } from "./background-removal";
import { compositePhraseBand, PRINT_CANVAS_WIDTH, PRINT_CANVAS_HEIGHT, PRINT_TEXT_BAND_HEIGHT } from "./text-layer";
import { langfuse } from "./langfuse";

let client: GoogleGenAI | null = null;

function hasApiKey(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

export function ai(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is missing. Add it to .env (get one free at https://aistudio.google.com/apikey)."
    );
  }
  client ??= new GoogleGenAI({ apiKey });
  return client;
}

/** Placeholder 1x1 transparent PNG as base64. */
const DUMMY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const DUMMY_CONCEPTS: Concept[] = [
  {
    title: "Read the Room",
    phrase: "Read the Room",
    visualConcept:
      "A bold open book with a speech bubble full of ellipsis dots, flat streetwear graphic style.",
    vibe: "sarcastic, witty, online",
    blurb: "For everyone who has ever had to say it.",
  },
  {
    title: "Main Character Energy",
    phrase: "Main Character",
    visualConcept:
      "A clapperboard with a crown on top, clean line-art, high-contrast two-color palette.",
    vibe: "chaotic, confident, drama",
    blurb: "The protagonist has logged on.",
  },
  {
    title: "No Cap",
    phrase: "No Cap",
    visualConcept:
      "A baseball cap with a red X through it, bold badge emblem layout, black and white.",
    vibe: "blunt, casual, internet",
    blurb: "Telling the truth has never looked this good.",
  },
  {
    title: "Spill It",
    phrase: "Spill It",
    visualConcept:
      "An overflowing teacup with steam rising in the shape of a gossip speech bubble, minimal flat art.",
    vibe: "messy, fun, relatable",
    blurb: "The tea is hot. The shirt is hotter.",
  },
  {
    title: "Sent on Read",
    phrase: "Sent on Read",
    visualConcept:
      "Two blue checkmarks inside a broken heart, street-art stencil style, limited palette.",
    vibe: "petty, dry, chronically online",
    blurb: "We've all been there.",
  },
];

/**
 * Ask the text model for N original t-shirt concepts for a keyword.
 * Returns validated Concept objects.
 */
export async function generateConcepts(
  keyword: string,
  count: number
): Promise<Concept[]> {
  if (!hasApiKey()) {
    // No Gemini key — return shuffled dummy concepts so the UI workflow completes.
    return DUMMY_CONCEPTS.slice(0, count).map((c) => ({
      ...c,
      blurb: `[DEMO] ${c.blurb ?? ""}`.trim(),
    }));
  }

  const res = await ai().models.generateContent({
    model: settings.gemini.textModel,
    contents: [
      { role: "user", parts: [{ text: prompts.conceptUser(keyword, count) }] },
    ],
    config: {
      systemInstruction: prompts.conceptSystem,
      temperature: settings.gemini.textTemperature,
      responseMimeType: "application/json",
      responseSchema: prompts.conceptSchema as unknown as Record<string, unknown>,
    },
  });

  const text = res.text;
  if (!text) throw new Error("Concept model returned no text.");

  let parsed: { concepts?: Concept[] };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Concept model returned non-JSON: ${text.slice(0, 200)}…`);
  }

  const concepts = (parsed.concepts ?? []).filter(
    (c): c is Concept => Boolean(c?.title && c?.phrase && c?.visualConcept)
  );
  if (concepts.length === 0) throw new Error("No valid concepts were produced.");
  return concepts.slice(0, count);
}

export interface BatchItem extends Concept {
  imageB64?: string;
  error?: string;
}

/**
 * Caps how many callers run at once; extra callers queue until a slot frees
 * up. Used to bound local background-removal work (ONNX inference is
 * CPU/memory heavy) independent of how many concepts are in a batch —
 * Gemini calls themselves stay fully parallel since they're network-bound.
 */
function createLimiter(concurrency: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const run = queue.shift()!;
    run();
  };
  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
  };
}

/**
 * Render one concept's final print-ready art. This is the single place that
 * decides how a concept becomes pixels — generateBatch, realizeDesign, and
 * the retry route all call this instead of each re-implementing the
 * raster-vs-svg split, which is exactly the kind of duplicated logic that
 * drifted out of sync earlier in this pipeline's history.
 *
 * - "raster": one image-model call draws illustration and text together.
 * - "svg": the image model draws illustration ONLY (designImageArtOnly) —
 *   it's unreliable at hand-drawing legible letterforms — and the exact
 *   phrase is rendered deterministically with real font glyphs (Satori),
 *   then composited into the fixed bottom band the illustration prompt is
 *   instructed to leave empty. Guarantees correct spelling and legibility
 *   for the "Minimalist Line Art" style, independent of the image model.
 *
 * `runBgRemoval` lets a caller share a concurrency limiter across a batch of
 * parallel renders (ONNX background removal is the CPU/memory-heavy local
 * step); single-design callers can omit it.
 */
export async function renderConceptArt(
  concept: Concept,
  parent?: any,
  runBgRemoval: (fn: () => Promise<string>) => Promise<string> = (fn) => fn()
): Promise<string> {
  const isSvgStyle = concept.artStyle === "svg";
  const genPrompt = isSvgStyle ? prompts.designImageArtOnly(concept) : prompts.designImage(concept);

  let imageB64 = await generateImage(genPrompt, settings.gemini.imagenFastModel, parent);

  try {
    imageB64 = await runBgRemoval(() => removeBgB64(imageB64));
  } catch {
    // Best-effort: the prompt already asks for a transparent background, so
    // fall back to the model's raw output rather than failing generation
    // over this local step.
  }

  if (!isSvgStyle) return imageB64;

  return compositePhraseBand(imageB64, concept.phrase, {
    canvasWidth: PRINT_CANVAS_WIDTH,
    canvasHeight: PRINT_CANVAS_HEIGHT,
    bandHeight: PRINT_TEXT_BAND_HEIGHT,
    color: isDarkGarment(concept.color || "Black") ? "#ffffff" : "#111111",
  });
}

/**
 * Stage 1: write concepts, then render each one's final print-ready artwork
 * directly with the image model (no hand-authored SVG intermediate — a text
 * model cannot reliably draw illustration or letterforms via raw path data,
 * see .junie/plans/design-quality-improvement-plan.md). Every concept is
 * fully realized here; there is no separate "preview vs realized" quality
 * gap for the caller to bridge later.
 */
export interface GenerateBatchOptions {
  style?: "raster" | "svg";
  category?: string;
  productType?: string;
  color?: string;
}

export async function generateBatch(
  keyword: string,
  count: number,
  options: GenerateBatchOptions = {},
  parent?: any
): Promise<BatchItem[]> {
  const { style = "raster", category, productType, color } = options;
  const observation = (parent || langfuse).span({
    name: "generateBatch",
    input: { keyword, count, style, category, productType, color },
    metadata: {
      conceptModel: settings.gemini.flashLiteModel,
      imageModel: settings.gemini.imagenFastModel,
    },
  });

  if (!hasApiKey()) {
    // No Gemini key — return shuffled dummy concepts so the UI workflow completes.
    const results = DUMMY_CONCEPTS.slice(0, count).map((c) => ({
      ...c,
      imageB64: DUMMY_PNG_B64,
      blurb: `[DEMO] ${c.blurb ?? ""}`.trim(),
    }));
    observation.end({ output: results });
    return results;
  }

  try {
    // Stage 1a: fast structured concept writing (text only — no illustration).
    const generationObservation = observation.generation({
      name: "gemini-batch-concepts",
      model: settings.gemini.flashLiteModel,
      modelParameters: {
        temperature: settings.gemini.textTemperature,
        responseMimeType: "application/json",
      },
      input: prompts.batchUser(keyword, count),
    });

    const res = await ai().models.generateContent({
      model: settings.gemini.flashLiteModel,
      contents: [
        { role: "user", parts: [{ text: prompts.batchUser(keyword, count) }] },
      ],
      config: {
        systemInstruction: prompts.batchSystem,
        temperature: settings.gemini.textTemperature,
        responseMimeType: "application/json",
        responseSchema: prompts.conceptSchema as unknown as Record<string, unknown>,
      },
    });

    const text = res.text;
    generationObservation.end({ output: text });

    if (!text) throw new Error("Batch model returned no text.");

    let parsed: { concepts?: Concept[] };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Batch model returned non-JSON: ${text.slice(0, 200)}…`);
    }

    const concepts = (parsed.concepts ?? []).filter(
      (c): c is Concept => Boolean(c?.title && c?.phrase && c?.visualConcept)
    );
    if (concepts.length === 0) throw new Error("No valid concepts were produced.");

    // Stage 1b: real artwork per concept, in parallel. One concept failing
    // (quota, model refusal, etc.) doesn't take down the rest of the batch —
    // it just comes back with `error` set.
    const limitBgRemoval = createLimiter(2);
    const items: BatchItem[] = await Promise.all(
      concepts.map(async (c) => {
        const withStyle: Concept = { ...c, artStyle: style, category, productType, color };
        try {
          const imageB64 = await renderConceptArt(withStyle, observation, limitBgRemoval);
          return { ...withStyle, imageB64 };
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          return { ...withStyle, imageB64: "", error };
        }
      })
    );

    observation.end({ output: items });
    return items;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    observation.end({ level: "error", statusMessage: message });
    throw err;
  }
}

/**
 * Fetch dynamic gossip examples from Gemini.
 */
export async function generateGossipExamples(): Promise<string[]> {
  if (!hasApiKey()) {
    return [
      "the group chat finally imploded",
      "celebrity feud of the week",
      "my situationship has a podcast now",
      "office drama: someone replied-all",
      "mercury is in microwave",
    ];
  }

  const res = await ai().models.generateContent({
    model: settings.gemini.textModel,
    contents: [{ role: "user", parts: [{ text: prompts.gossipExamples }] }],
    config: {
      temperature: 0.8,
      responseMimeType: "application/json",
    },
  });

  const text = res.text;
  if (!text) throw new Error("Gossip model returned no text.");

  try {
    const parsed = JSON.parse(text);
    return parsed.examples || [];
  } catch {
    throw new Error("Gossip model returned invalid JSON.");
  }
}

/**
 * Generate a single image from a prompt. Returns base64-encoded PNG bytes.
 * Auto-routes: "imagen*" models use the Images API; everything else uses the
 * Gemini native image output (Nano Banana family).
 */
export async function generateImage(prompt: string, modelOverride?: string, parent?: any): Promise<string> {
  const observation = (parent || langfuse).generation({
    name: "generateImage",
    model: modelOverride || settings.gemini.imageModel,
    input: prompt,
  });

  if (!hasApiKey()) {
    // No Gemini key — return a 1×1 transparent placeholder so the pipeline completes.
    observation.end({ output: DUMMY_PNG_B64 });
    return DUMMY_PNG_B64;
  }

  const model = modelOverride || settings.gemini.imageModel;

  try {
    if (model.toLowerCase().includes("imagen")) {
      const res = await ai().models.generateImages({
        model,
        prompt,
        config: { numberOfImages: 1 },
      });
      const b64 = res.generatedImages?.[0]?.image?.imageBytes;
      if (!b64) throw new Error(`Imagen model "${model}" returned no image.`);
      observation.end({ output: "[image bytes]" });
      return b64;
    }

    const res = await ai().models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { responseModalities: ["IMAGE"] },
    });

    const parts = res.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      if (part.inlineData?.data) {
        observation.end({ output: "[image data]" });
        return part.inlineData.data;
      }
    }
    throw new Error(
      `Image model "${model}" returned no image data. ` +
        `If this model isn't enabled on your key, set GEMINI_IMAGE_MODEL to one that is.`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    observation.end({ level: "error", statusMessage: message });
    throw err;
  }
}
