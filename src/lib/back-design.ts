import QRCode from "qrcode";
import sharp from "sharp";
import { renderPhraseSvg, PRINT_CANVAS_WIDTH, PRINT_CANVAS_HEIGHT } from "./text-layer";
import { isDarkGarment } from "@/config/prompts";

/**
 * A/B/C variant for how large/where the back print sits on the garment.
 * Randomly assigned per Design at generation time (pickRandomBackLayout),
 * persisted, and flippable later by an admin — see Design.backLayout.
 */
export type BackLayout = "upper-back" | "full-panel" | "chest-height";

const BACK_LAYOUTS: BackLayout[] = ["upper-back", "full-panel", "chest-height"];

export function pickRandomBackLayout(): BackLayout {
  return BACK_LAYOUTS[Math.floor(Math.random() * BACK_LAYOUTS.length)];
}

/** The site QR always points here for now — a per-design deep link is a later iteration. */
export const BACK_QR_URL = "https://wearthistea.web.app";
const QR_CAPTION = "wearthistea.web.app";

interface BackBox {
  width: number;
  height: number;
  top: number;
  left: number;
}

/**
 * Target box (within the print canvas) each layout renders into. Deliberately
 * NOT the full canvas for "upper-back"/"chest-height" — PrintRove auto-trims
 * uploaded art to its content bounding box and then rescales it to fill
 * whatever placement box is requested (see printrove.ts's trimDesign() doc
 * comment), so canvas padding alone can't make a print "small"; the box size
 * itself is what controls the real printed footprint.
 */
export function backBoxForLayout(layout: BackLayout, canvasWidth: number, canvasHeight: number): BackBox {
  switch (layout) {
    case "upper-back": {
      const width = Math.round(canvasWidth * 0.65);
      const height = Math.round(canvasHeight * 0.35);
      return { width, height, left: Math.round((canvasWidth - width) / 2), top: Math.round(canvasHeight * 0.08) };
    }
    case "chest-height": {
      const width = Math.round(canvasWidth * 0.55);
      const height = Math.round(canvasHeight * 0.45);
      return { width, height, left: Math.round((canvasWidth - width) / 2), top: Math.round(canvasHeight * 0.18) };
    }
    case "full-panel": {
      const width = Math.round(canvasWidth * 0.9);
      const height = Math.round(canvasHeight * 0.9);
      return { width, height, left: Math.round((canvasWidth - width) / 2), top: Math.round((canvasHeight - height) / 2) };
    }
  }
}

/**
 * Render the back print: a cheeky payoff line (Satori text, same approach as
 * text-layer.ts's phrase band) over a small QR code + caption, split 4:1
 * (text zone : QR zone) by height within the layout's box. The QR is always
 * rendered as a standard black-on-white PNG regardless of garment color —
 * its own white field is the quiet zone a scanner needs; flipping it to
 * light-ink-on-transparent for dark garments would risk scan failures, which
 * would defeat the point of the feature. Only the cheeky text's ink color
 * follows the garment (see isDarkGarment() in prompts.ts).
 */
export async function renderBackDesignArtwork(
  backPhrase: string,
  opts: {
    layout: BackLayout;
    color: string;
    qrUrl?: string;
    canvasWidth?: number;
    canvasHeight?: number;
  }
): Promise<string> {
  const canvasWidth = opts.canvasWidth ?? PRINT_CANVAS_WIDTH;
  const canvasHeight = opts.canvasHeight ?? PRINT_CANVAS_HEIGHT;
  const box = backBoxForLayout(opts.layout, canvasWidth, canvasHeight);
  // opts.color is the garment color name ("Black"), not a text color — passing
  // it straight to renderPhraseSvg rendered literal black text, invisible on a
  // black tee. Resolve it to a contrasting ink color the same way the front
  // art does (see isDarkGarment in gemini.ts).
  const inkColor = isDarkGarment(opts.color || "Black") ? "#ffffff" : "#111111";

  // 4:1 vertical split — text zone : QR zone.
  const qrZoneHeight = Math.round(box.height / 5);
  const textZoneHeight = box.height - qrZoneHeight;

  const textSvg = await renderPhraseSvg(backPhrase, {
    width: box.width,
    height: textZoneHeight,
    color: inkColor,
  });
  const textPng = await sharp(Buffer.from(textSvg), { density: 300 })
    .resize(box.width, textZoneHeight, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  // Within the QR zone: a small caption above a centered QR code.
  const captionHeight = Math.round(qrZoneHeight * 0.22);
  const qrAreaHeight = qrZoneHeight - captionHeight;
  const qrSize = Math.max(64, Math.round(Math.min(box.width * 0.4, qrAreaHeight * 0.92)));

  const qrPng = await QRCode.toBuffer(opts.qrUrl ?? BACK_QR_URL, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 2,
    width: qrSize,
    color: { dark: "#000000", light: "#FFFFFF" },
  });

  const captionSvg = await renderPhraseSvg(QR_CAPTION, {
    width: box.width,
    height: captionHeight,
    color: inkColor,
  });
  const captionPng = await sharp(Buffer.from(captionSvg), { density: 300 })
    .resize(box.width, captionHeight, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const qrZonePng = await sharp({
    create: { width: box.width, height: qrZoneHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      { input: captionPng, left: 0, top: 0 },
      {
        input: qrPng,
        left: Math.round((box.width - qrSize) / 2),
        top: captionHeight + Math.round((qrAreaHeight - qrSize) / 2),
      },
    ])
    .png()
    .toBuffer();

  const boxPng = await sharp({
    create: { width: box.width, height: box.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      { input: textPng, left: 0, top: 0 },
      { input: qrZonePng, left: 0, top: textZoneHeight },
    ])
    .png()
    .toBuffer();

  const canvas = await sharp({
    create: { width: canvasWidth, height: canvasHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: boxPng, left: box.left, top: box.top }])
    .png()
    .toBuffer();

  return canvas.toString("base64");
}
