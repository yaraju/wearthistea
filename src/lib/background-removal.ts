import { removeBackground, type Config } from "@imgly/background-removal-node";

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

  try {
    const blob = await removeBackground(imageSource, config);
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
