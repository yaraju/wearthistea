// Quick probe for the Gemini image model. Run:
//   node --env-file=.env scripts/test-gemini-image.mjs
import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
console.log("Using image model:", model);
console.log("Key present:", Boolean(apiKey));

const ai = new GoogleGenAI({ apiKey });
const prompt =
  "A bold streetwear t-shirt graphic, isolated on transparent background, the text 'ZAP! COSMIC CHAOS' in punchy display lettering, simple line-art microwave with lightning. High contrast, screen-print style.";

try {
  const res = await ai.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { responseModalities: ["IMAGE"] },
  });

  const parts = res?.candidates?.[0]?.content?.parts ?? [];
  console.log("candidates:", res?.candidates?.length ?? 0);
  console.log("parts:", parts.length);
  for (const p of parts) {
    if (p.inlineData) {
      console.log("✅ GOT IMAGE:", p.inlineData.mimeType, "bytes~", (p.inlineData.data || "").length);
    } else if (p.text) {
      console.log("📝 TEXT PART:", p.text.slice(0, 300));
    } else {
      console.log("❓ OTHER PART KEYS:", Object.keys(p));
    }
  }
  if (parts.length === 0) {
    console.log("promptFeedback:", JSON.stringify(res?.promptFeedback));
    console.log("finishReason:", res?.candidates?.[0]?.finishReason);
    console.log("full (trimmed):", JSON.stringify(res).slice(0, 800));
  }
} catch (err) {
  console.log("❌ ERROR NAME:", err?.name);
  console.log("❌ ERROR MESSAGE:", err?.message);
  if (err?.status) console.log("status:", err.status);
  if (err?.response) console.log("response:", JSON.stringify(err.response).slice(0, 800));
}
