/**
 * Raster -> SVG for the Jev B3 arm on real generated art. The pipeline has no
 * native SVG, so this is the production-realistic bridge. Latency is measured
 * and charged to the arm. The result is shrunk until it fits a token budget
 * (Jev state limit is 32K tokens alongside the questions).
 */
import sharp from "sharp";
import { vectorize, ColorMode, Hierarchical, PathSimplifyMode } from "@neplex/vectorizer";

export interface Vectorized {
  svg: string;
  ms: number;
  attempts: number;
  chars: number;
}

// ~3 chars/token for path data is a safe-side estimate.
const MAX_CHARS = 60_000;

export async function vectorizeForJev(imageB64: string): Promise<Vectorized> {
  const started = performance.now();
  let size = 512;
  let precision = 4;
  let speckle = 8;
  for (let attempt = 1; attempt <= 5; attempt++) {
    // Flatten alpha onto no background: keep alpha so transparent regions stay unpainted.
    const png = await sharp(Buffer.from(imageB64, "base64"))
      .resize(size, size, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    const svg = await vectorize(png, {
      colorMode: ColorMode.Color,
      hierarchical: Hierarchical.Stacked,
      filterSpeckle: speckle,
      colorPrecision: precision,
      layerDifference: 24,
      mode: PathSimplifyMode.Spline,
      cornerThreshold: 60,
      lengthThreshold: 4,
      maxIterations: 2,
      spliceThreshold: 45,
      pathPrecision: 1,
    });
    if (svg.length <= MAX_CHARS || attempt === 5) {
      return { svg, ms: performance.now() - started, attempts: attempt, chars: svg.length };
    }
    size = Math.round(size * 0.75);
    precision = Math.max(2, precision - 1);
    speckle += 6;
  }
  throw new Error("unreachable");
}
