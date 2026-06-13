// Visual check for the tee mockup compositor (no AI / billing needed).
//   node scripts/test-mockup.mjs   →   public/generated/_preview/sample.png
import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const W = 1200, H = 1500;
const fill = "#1c1b1a"; // black tee

const teeSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="bg" cx="50%" cy="38%" r="75%">
      <stop offset="0%" stop-color="#faf5ea"/><stop offset="100%" stop-color="#f1ead9"/>
    </radialGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="16" stdDeviation="26" flood-color="#1c160c" flood-opacity="0.16"/>
    </filter>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <g filter="url(#shadow)">
    <path d="M 470 205 L 175 330 L 110 480 L 300 432 L 318 1380 L 882 1380 L 900 432 L 1090 480 L 1025 330 L 730 205 C 690 285 510 285 470 205 Z" fill="${fill}"/>
    <path d="M 470 205 C 510 285 690 285 730 205" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="10"/>
    <path d="M 318 1380 L 300 432" fill="none" stroke="rgba(0,0,0,0.10)" stroke-width="6"/>
    <path d="M 882 1380 L 900 432" fill="none" stroke="rgba(0,0,0,0.10)" stroke-width="6"/>
  </g>
</svg>`;

// Synthetic "design": transparent PNG with a circle + bold phrase.
const designSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900" viewBox="0 0 900 900">
  <circle cx="450" cy="360" r="200" fill="none" stroke="#ff2e6e" stroke-width="26"/>
  <path d="M360 300 L520 300 L380 470 L540 470" fill="none" stroke="#ffe14d" stroke-width="34" stroke-linejoin="round" stroke-linecap="round"/>
  <text x="450" y="700" text-anchor="middle" font-family="Georgia, serif" font-weight="700" font-size="92" fill="#f3efe6">ZAP! COSMIC</text>
  <text x="450" y="800" text-anchor="middle" font-family="Georgia, serif" font-weight="700" font-size="92" fill="#ff2e6e">CHAOS</text>
</svg>`;

const designPng = await sharp(Buffer.from(designSvg)).png().toBuffer();

const boxW = 470, boxH = 560;
const design = await sharp(designPng)
  .resize({ width: boxW, height: boxH, fit: "inside" })
  .png()
  .toBuffer();
const meta = await sharp(design).metadata();
const left = Math.round((W - meta.width) / 2);
const top = 392;

const out = await sharp(Buffer.from(teeSvg))
  .composite([{ input: design, left, top }])
  .png()
  .toBuffer();

const dir = path.join(process.cwd(), "public", "generated", "_preview");
await mkdir(dir, { recursive: true });
const file = path.join(dir, "sample.png");
await writeFile(file, out);
console.log("Wrote", file, `(${out.length} bytes)`);
