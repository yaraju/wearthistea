import { GoogleGenAI } from "@google/genai";
import { settings } from "@/config/settings";
import { prompts, type Concept } from "@/config/prompts";
import { svgToPng } from "./svg-utils";
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
 * Modernized: Generate concepts AND SVG previews in a single fast call.
 * Both Raster and SVG modes start with minimalist vector previews (Stage 1).
 */
export async function generateBatch(
  keyword: string,
  count: number,
  mode: "raster" | "svg" = "raster",
  parent?: any
): Promise<BatchItem[]> {
  const observation = (parent || langfuse).span({
    name: "generateBatch",
    input: { keyword, count, mode },
    metadata: { model: settings.gemini.flashLiteModel },
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
    // Use Flash Lite for Stage 1 batching (Concepts + SVG Previews)
    const generationObservation = observation.generation({
      name: "gemini-batch-gen",
      model: settings.gemini.flashLiteModel,
      modelParameters: {
        temperature: settings.gemini.textTemperature,
        responseMimeType: "application/json",
      },
      input: prompts.batchSVGUser(keyword, count),
    });

    const res = await ai().models.generateContent({
      model: settings.gemini.flashLiteModel,
      contents: [
        { role: "user", parts: [{ text: prompts.batchSVGUser(keyword, count) }] },
      ],
      config: {
        systemInstruction: prompts.batchSVGSystem,
        temperature: settings.gemini.textTemperature,
        responseMimeType: "application/json",
        responseSchema: prompts.conceptSVGSchema as unknown as Record<string, unknown>,
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

    const items = await Promise.all(
      concepts.map(async (c) => {
        let imageB64 = "";
        let error: string | undefined;
        if (c.svg) {
          const svgSpan = observation.span({ name: "svgToPng", input: { svg: c.svg.slice(0, 100) + "..." } });
          try {
            // Even for "raster" mode, we render the SVG as an initial preview.
            imageB64 = await svgToPng(c.svg);
            svgSpan.end({ output: "success" });
          } catch (err) {
            error = `SVG rendering failed: ${
              err instanceof Error ? err.message : String(err)
            }`;
            svgSpan.end({ level: "error", statusMessage: error });
          }
        } else {
          error = "SVG code missing in response";
        }
        return { ...c, imageB64, error };
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
 * Generate a single SVG for a concept (used for retries).
 */
export async function generateSingleSVG(concept: Concept): Promise<string> {
  if (!hasApiKey()) return DUMMY_PNG_B64;

  const res = await ai().models.generateContent({
    model: settings.gemini.textModel,
    contents: [{ role: "user", parts: [{ text: prompts.svgUser(concept) }] }],
    config: {
      systemInstruction: prompts.svgSystem,
      temperature: settings.gemini.textTemperature,
    },
  });

  const text = res.text;
  if (!text) throw new Error("SVG model returned no text.");

  const match = text.match(/<svg[\s\S]*<\/svg>/);
  const svg = match ? match[0] : text;
  return svgToPng(svg);
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
