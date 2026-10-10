/**
 * Generates real end-to-end art with the PRODUCTION pipeline functions
 * (generateConcepts -> renderConceptArt -> bg removal -> resolveGarmentColor)
 * for the System One spike. Stays local: PNGs + a manifest go to
 * spike-results/art/, nothing touches the DB or GCS.
 *
 * The production pipeline lets the image model pick garment color; to get a
 * Black flow and a White flow we append a color PREFERENCE to the concept's
 * visualConcept (spike-only) and then record the color the pipeline actually
 * resolved. Labels always use the resolved color, never the requested one.
 */
import { mkdirSync, writeFileSync } from "node:fs";

export interface ArtItem {
  id: string;
  keyword: string;
  requested: "Black" | "White";
  resolved: "Black" | "White";
  phrase: string;
  visualConcept: string;
  backPhrase?: string | null;
  file: string;
  renderMs: number;
  error?: string;
}

const KEYWORDS = [
  "mercury is in microwave",
  "office drama: someone replied-all",
  "my situationship has a podcast now",
  "the group chat finally imploded",
  "my roommate ate my labeled food again",
  "he liked her photo from 3 years ago",
  "someone screenshotted the whole chat",
  "my coworker microwaved fish again",
];

export async function genArt(perKeyword: number, outDir = "spike-results/art"): Promise<ArtItem[]> {
  const { generateConcepts, renderConceptArt } = await import("../../src/lib/gemini");
  mkdirSync(outDir, { recursive: true });
  const items: ArtItem[] = [];
  let n = 0;
  for (const keyword of KEYWORDS) {
    const concepts = await generateConcepts(keyword, perKeyword, { style: "raster" });
    await Promise.all(
      concepts.map(async (c, ci) => {
        const requested: "Black" | "White" = (n + ci) % 2 === 0 ? "Black" : "White";
        const id = `art-${String(n + ci).padStart(2, "0")}`;
        const steer =
          requested === "Black"
            ? " Garment preference: BLACK shirt, so draw in bright white/neon light ink."
            : " Garment preference: WHITE shirt, so draw in black/deep dark ink.";
        const concept = { ...c, visualConcept: `${c.visualConcept}${steer}`, artStyle: "raster" as const };
        const started = performance.now();
        try {
          const { imageB64, variantColor } = await renderConceptArt(concept);
          const file = `${outDir}/${id}.png`;
          writeFileSync(file, Buffer.from(imageB64, "base64"));
          items.push({
            id,
            keyword,
            requested,
            resolved: variantColor,
            phrase: c.phrase,
            visualConcept: c.visualConcept,
            backPhrase: c.backPhrase,
            file,
            renderMs: performance.now() - started,
          });
        } catch (err) {
          items.push({
            id,
            keyword,
            requested,
            resolved: requested,
            phrase: c.phrase,
            visualConcept: c.visualConcept,
            backPhrase: c.backPhrase,
            file: "",
            renderMs: performance.now() - started,
            error: err instanceof Error ? err.message.slice(0, 200) : String(err),
          });
        }
      })
    );
    n += concepts.length;
    console.log(`  ${keyword}: ${items.length} total`);
  }
  writeFileSync(`${outDir}/manifest.json`, JSON.stringify(items, null, 1));
  return items;
}
