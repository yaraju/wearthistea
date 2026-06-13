import sharp from "sharp";

// Preview canvas — 4:5 to match the card aspect ratio.
const W = 1200;
const H = 1500;

// Common Bella+Canvas colours → preview hex. Falls back to a soft black.
const COLOR_HEX: Record<string, string> = {
  black: "#1c1b1a",
  white: "#f3efe6",
  navy: "#222c3c",
  red: "#9d2a2a",
  maroon: "#5a2230",
  "forest green": "#23402f",
  forest: "#23402f",
  "military green": "#4a4a36",
  "athletic heather": "#bdb6a9",
  heather: "#bdb6a9",
  "heather grey": "#bdb6a9",
  "heather gray": "#bdb6a9",
  grey: "#8b8782",
  gray: "#8b8782",
  sand: "#d9cdb6",
  natural: "#e6dcc6",
  "dusty blue": "#8aa0b1",
  pink: "#e6b3c2",
  mustard: "#c89a3c",
};

function colorHex(name: string): string {
  return COLOR_HEX[name.trim().toLowerCase()] ?? "#1c1b1a";
}

// A flat, editorial t-shirt silhouette on a warm paper backdrop.
function teeSvg(fill: string): Buffer {
  const paper = "#f1ead9";
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="bg" cx="50%" cy="38%" r="75%">
      <stop offset="0%" stop-color="#faf5ea"/>
      <stop offset="100%" stop-color="${paper}"/>
    </radialGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="16" stdDeviation="26" flood-color="#1c160c" flood-opacity="0.16"/>
    </filter>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>

  <g filter="url(#shadow)">
    <path d="
      M 470 205
      L 175 330
      L 110 480
      L 300 432
      L 318 1380
      L 882 1380
      L 900 432
      L 1090 480
      L 1025 330
      L 730 205
      C 690 285 510 285 470 205
      Z" fill="${fill}"/>
    <!-- collar rib highlight -->
    <path d="M 470 205 C 510 285 690 285 730 205"
      fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="10"/>
    <!-- soft seam shading -->
    <path d="M 352 1372 L 300 432" fill="none" stroke="rgba(0,0,0,0.10)" stroke-width="6"/>
    <path d="M 848 1372 L 900 432" fill="none" stroke="rgba(0,0,0,0.10)" stroke-width="6"/>
  </g>
</svg>`;
  return Buffer.from(svg);
}

/**
 * Composite a (transparent) design PNG onto a flat tee mockup of the given
 * garment colour. Returns a base64-encoded PNG preview. Free — no API call.
 */
export async function compositeOnTee(
  designBase64: string,
  garmentColor: string
): Promise<string> {
  const base = sharp(teeSvg(colorHex(garmentColor)));

  // Fit the artwork into the chest print box, centered.
  const boxW = 470;
  const boxH = 560;
  const design = await sharp(Buffer.from(designBase64, "base64"))
    .resize({ width: boxW, height: boxH, fit: "inside", withoutEnlargement: false })
    .png()
    .toBuffer();
  const meta = await sharp(design).metadata();

  const left = Math.round((W - (meta.width ?? boxW)) / 2);
  const top = 392; // a little below the collar

  const out = await base
    .composite([{ input: design, left, top }])
    .png()
    .toBuffer();

  return out.toString("base64");
}
