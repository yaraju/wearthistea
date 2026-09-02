import sharp from "sharp";
import { removeBackground, type Config } from "@imgly/background-removal-node";

const MIME_BY_FORMAT: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  webp: "image/webp",
};

/**
 * Local background removal using @imgly/background-removal-node.
 * Uses ONNX models to segment the foreground and return a transparent PNG.
 */
export async function removeBg(imageSource: string | Buffer | Uint8Array): Promise<Buffer> {
  const config: Config = {
    debug: false,
    model: "medium", // 'small' is faster, 'medium' is better quality
    output: {
      format: "image/png",
      quality: 0.8,
    },
  };

  // Every caller here passes base64-encoded image bytes, never a URL/path —
  // but the library's `string` input type means one too, so a raw base64
  // string gets misread as a file path (ENAMETOOLONG) or URL. And its Buffer
  // handling wraps bytes in `new Blob([bytes])` with no `type` set, which the
  // decoder then rejects as "Unsupported format: " (empty mime). Gemini can
  // also return JPEG despite the prompt asking for PNG — JPEG has no alpha
  // channel at all, so that has to be handled here too, not assumed away.
  // Fix: decode bytes ourselves, sniff the real format, and hand the library
  // an explicitly-typed Blob so its format detection has something to read.
  const bytes = typeof imageSource === "string" ? Buffer.from(imageSource, "base64") : Buffer.from(imageSource);
  const { format } = await sharp(bytes).metadata();
  const type = MIME_BY_FORMAT[format ?? ""] ?? "image/png";
  const input = new Blob([bytes], { type });

  try {
    const blob = await removeBackground(input, config);
    return Buffer.from(await blob.arrayBuffer());
  } catch (error) {
    console.error("Background removal failed:", error);
    throw new Error("Failed to remove background locally.");
  }
}

/**
 * Helper to remove background and return base64 string.
 */
export async function removeBgB64(imageSource: string | Buffer | Uint8Array): Promise<string> {
  const buffer = await removeBg(imageSource);
  return buffer.toString("base64");
}
