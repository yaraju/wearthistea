import { readFileSync } from "node:fs";
import path from "node:path";
import satori from "satori";
import sharp from "sharp";

const FONT_PATH = path.join(/*turbopackIgnore: true*/ process.cwd(), "public", "fonts", "ArchivoBlack-Regular.ttf");
const FONT_FAMILY = "ArchivoBlack";

// Must match the fixed layout described in prompts.ts's designImageArtOnly()
// COMPOSITION section (top 74% illustration / bottom 26% empty band) and
// PRINT_SPECS's 4500x5400 canvas — these three things have to agree or the
// text lands somewhere the illustration didn't actually leave empty.
export const PRINT_CANVAS_WIDTH = 4500;
export const PRINT_CANVAS_HEIGHT = 5400;
export const PRINT_TEXT_BAND_HEIGHT = 1400;

let fontData: ArrayBuffer | null = null;
function loadFont(): ArrayBuffer {
  if (!fontData) {
    const buf = readFileSync(FONT_PATH);
    fontData = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  }
  return fontData;
}

/**
 * Rough font-size estimate for Archivo Black so a short phrase (2-5 words,
 * <=32 chars per CONCEPT_RULES) fills the band without measuring text —
 * satori has no built-in autofit. Deliberately conservative: it's fine to
 * undersize a short phrase, it is not fine to overflow a long one.
 */
function estimateFontSize(phrase: string, width: number, height: number): number {
  const charsPerLine = Math.max(phrase.length / 2, phrase.split(" ")[0]?.length ?? 8);
  const byWidth = (width * 0.88) / (charsPerLine * 0.66);
  const byHeight = height * 0.24;
  return Math.max(40, Math.min(byWidth, byHeight));
}

/**
 * Render a phrase as a standalone SVG using real font glyph outlines (via
 * Satori) instead of asking an image model to hand-draw display lettering.
 * Guarantees exact spelling and legibility — the thing the image model
 * alone was least reliable at (see design-quality-improvement-plan.md).
 */
export async function renderPhraseSvg(
  phrase: string,
  opts: { width: number; height: number; color: string }
): Promise<string> {
  const fontSize = estimateFontSize(phrase, opts.width, opts.height);
  // Satori's TS types expect a real ReactNode; it only needs this plain
  // { type, props } shape at runtime (no React/JSX dependency here).
  const node = {
    type: "div",
    props: {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        alignContent: "center",
        justifyContent: "center",
        textAlign: "center",
        color: opts.color,
        fontFamily: FONT_FAMILY,
        fontSize,
        lineHeight: 1.05,
        letterSpacing: "-0.02em",
        textTransform: "uppercase",
        padding: "24px 48px",
      },
      children: phrase,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return satori(
    node,
    {
      width: opts.width,
      height: opts.height,
      fonts: [{ name: FONT_FAMILY, data: loadFont(), weight: 400, style: "normal" }],
    }
  );
}

/**
 * Composite a Satori-rendered phrase into the bottom band of a print canvas
 * that an art-only illustration left empty. Both layers are transparent
 * PNGs; the result is a single flattened transparent PNG.
 */
export async function compositePhraseBand(
  illustrationB64: string,
  phrase: string,
  opts: { canvasWidth: number; canvasHeight: number; bandHeight: number; color: string }
): Promise<string> {
  const bandSvg = await renderPhraseSvg(phrase, {
    width: opts.canvasWidth,
    height: opts.bandHeight,
    color: opts.color,
  });
  const bandPng = await sharp(Buffer.from(bandSvg), { density: 300 })
    .resize(opts.canvasWidth, opts.bandHeight, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  // Resize the illustration to exactly fill the top region (not the whole
  // canvas) and composite it at top:0 — this reserves the bottom band by
  // construction. Using `fit:"contain"` against the FULL canvas here would
  // only keep the band clear if the model happened to return exactly the
  // same aspect ratio as canvasWidth:canvasHeight; it usually doesn't
  // (e.g. Gemini returning 944x1136 against a 4500x5400 target), so the
  // illustration could silently creep into (or short of) the reserved band.
  const topRegionHeight = opts.canvasHeight - opts.bandHeight;
  const illustration = await sharp(Buffer.from(illustrationB64, "base64"))
    .resize(opts.canvasWidth, topRegionHeight, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const canvas = await sharp({
    create: {
      width: opts.canvasWidth,
      height: opts.canvasHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      { input: illustration, left: 0, top: 0 },
      { input: bandPng, left: 0, top: topRegionHeight },
    ])
    .png()
    .toBuffer();

  return canvas.toString("base64");
}
