import sharp from "sharp";

/**
 * Convert an SVG string to a high-resolution transparent PNG.
 * Scaled to 4500x5400 for standard print-on-demand requirements (300 DPI).
 */
export async function svgToPng(svg: string): Promise<string> {
  if (!svg.includes("<svg")) {
    throw new Error("Invalid SVG string provided.");
  }

  // Use a high density for initial rasterization to keep vector edges crisp.
  const buf = await sharp(Buffer.from(svg), { density: 300 })
    .resize(4500, 5400, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  return buf.toString("base64");
}
