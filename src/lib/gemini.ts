import { GoogleGenAI } from "@google/genai";
import { settings } from "@/config/settings";
import { prompts, type Concept } from "@/config/prompts";

let client: GoogleGenAI | null = null;

function hasApiKey(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

function ai(): GoogleGenAI {
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

/**
 * Generate a single image from a prompt. Returns base64-encoded PNG bytes.
 * Auto-routes: "imagen*" models use the Images API; everything else uses the
 * Gemini native image output (Nano Banana family).
 */
export async function generateImage(prompt: string): Promise<string> {
  if (!hasApiKey()) {
    // No Gemini key — return a 1×1 transparent placeholder so the pipeline completes.
    return DUMMY_PNG_B64;
  }

  const model = settings.gemini.imageModel;

  if (model.toLowerCase().includes("imagen")) {
    const res = await ai().models.generateImages({
      model,
      prompt,
      config: { numberOfImages: 1 },
    });
    const b64 = res.generatedImages?.[0]?.image?.imageBytes;
    if (!b64) throw new Error(`Imagen model "${model}" returned no image.`);
    return b64;
  }

  const res = await ai().models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { responseModalities: ["IMAGE"] },
  });

  const parts = res.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    if (part.inlineData?.data) return part.inlineData.data;
  }
  throw new Error(
    `Image model "${model}" returned no image data. ` +
      `If this model isn't enabled on your key, set GEMINI_IMAGE_MODEL to one that is.`
  );
}
