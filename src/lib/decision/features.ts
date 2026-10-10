/**
 * Programmatic image features for text-only decision models (Jev cannot see
 * pixels). Everything here is measured with sharp, not guessed.
 */
import sharp from "sharp";

export interface ImageFeatures {
  width: number;
  height: number;
  /** Mean luminance 0-255 of non-transparent pixels (same rule as gemini.ts measureInkLuminance). */
  inkLuminance: number | null;
  /** Fraction of pixels with alpha >= 16. */
  inkCoverage: number;
  /** Fraction of pixels with alpha >= 250 (fully opaque). */
  opaqueCoverage: number;
  /** Fraction of the 1px border ring that is non-transparent. High => opaque background or cropped art. */
  borderInkFraction: number;
  /** Ink bounding box, normalized 0-1. */
  bbox: { x0: number; y0: number; x1: number; y1: number } | null;
  /** Fraction of the bbox area that is ink: low for line art, high for blobs/silhouettes. */
  bboxFill: number;
  /** Number of distinct quantized colors (4 bits/channel) among ink pixels. */
  distinctColors: number;
}

export async function extractFeatures(imageB64: string): Promise<ImageFeatures> {
  const { data, info } = await sharp(Buffer.from(imageB64, "base64"))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let ink = 0;
  let opaque = 0;
  let lum = 0;
  let border = 0;
  let borderTotal = 0;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  const colors = new Set<number>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const a = data[i + 3];
      const onBorder = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      if (onBorder) borderTotal++;
      if (a < 16) continue;
      ink++;
      if (a >= 250) opaque++;
      if (onBorder) border++;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      lum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  const total = width * height;
  const bbox = ink === 0 ? null : { x0: x0 / width, y0: y0 / height, x1: (x1 + 1) / width, y1: (y1 + 1) / height };
  const bboxArea = bbox ? (bbox.x1 - bbox.x0) * (bbox.y1 - bbox.y0) * total : 0;
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  return {
    width,
    height,
    inkLuminance: ink === 0 ? null : r3(lum / ink),
    inkCoverage: r3(ink / total),
    opaqueCoverage: r3(opaque / total),
    borderInkFraction: r3(borderTotal ? border / borderTotal : 0),
    bbox: bbox && { x0: r3(bbox.x0), y0: r3(bbox.y0), x1: r3(bbox.x1), y1: r3(bbox.y1) },
    bboxFill: r3(bboxArea ? ink / bboxArea : 0),
    distinctColors: colors.size,
  };
}
