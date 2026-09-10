import sharp from "sharp";

/**
 * Downscale a base64 PNG to a screen-quality preview — crisp on screen,
 * unusable for print. Keeps alpha (PNG, not JPEG) since design art has a
 * transparent background.
 */
export async function createPreviewImage(base64: string, maxDim = 900): Promise<string> {
  const buf = await sharp(Buffer.from(base64, "base64"))
    .resize(maxDim, maxDim, { fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
  return buf.toString("base64");
}
