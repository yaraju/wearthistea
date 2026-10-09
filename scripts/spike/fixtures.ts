/**
 * Labeled native-SVG fixtures for the System One spike. Each fixture is a
 * self-contained SVG (800x800, transparent canvas) with exact ground truth,
 * rendered to PNG via sharp so every arm judges the same artifact:
 * Gemini/DiffusionGemma see the PNG, Jev B3 reads the SVG source, Jev B1/B2
 * get sharp-measured features of the PNG.
 */
import sharp from "sharp";

export type FixtureKind = "clean" | "wrongInk" | "garment" | "cropped" | "opaqueBg" | "misspelled";
export type Color = "Black" | "White";

export interface Fixture {
  id: string;
  kind: FixtureKind;
  claimedColor: Color;
  phrase: string;
  visualConcept: string;
  svg: string;
  imageB64: string;
  truth: {
    usable: boolean;
    colorMatchesArt: boolean;
    garmentDrawn: boolean;
    opaqueBackground: boolean;
    cropped: boolean;
    phraseCorrect: boolean;
    inkLight: boolean;
  };
}

// Concept text is matched to the icon actually drawn so a vision judge's
// "does the art match the concept" check is not a confound.
const PHRASES = [
  ["NO CAP", "A single bold filled circle icon, with the shirt phrase printed as bold text beneath it."],
  ["SPILL IT", "A single bold filled five-point star icon, with the shirt phrase printed as bold text beneath it."],
  ["SENT ON READ", "A single bold filled coffee-mug silhouette icon, with the shirt phrase printed as bold text beneath it."],
] as const;

function icon(variant: number, ink: string): string {
  if (variant % 3 === 0) return `<circle cx="400" cy="330" r="140" fill="${ink}"/>`;
  if (variant % 3 === 1) {
    return `<polygon points="400,170 445,290 575,290 470,365 510,490 400,415 290,490 330,365 225,290 355,290" fill="${ink}"/>`;
  }
  return `<path d="M270 250 H530 V380 Q530 480 400 480 Q270 480 270 380 Z M530 290 H590 Q630 290 630 340 Q630 390 590 390 H530" fill="${ink}"/>`;
}

function misspell(s: string): string {
  // swap first two letters of the longest word: deterministic, obviously wrong
  const words = s.split(" ");
  let idx = 0;
  words.forEach((w, i) => {
    if (w.length > words[idx].length) idx = i;
  });
  const w = words[idx];
  words[idx] = w[1] + w[0] + w.slice(2) + w[w.length - 1];
  return words.join(" ");
}

async function build(i: number, kind: FixtureKind, claimedColor: Color): Promise<Fixture> {
  const [phrase, visualConcept] = PHRASES[i % PHRASES.length];
  const good = claimedColor === "Black" ? "rgb(245,245,245)" : "rgb(20,20,20)";
  const bad = claimedColor === "Black" ? "rgb(20,20,20)" : "rgb(245,245,245)";
  const ink = kind === "wrongInk" ? bad : good;
  const inkLight = ink === "rgb(245,245,245)";
  const text = kind === "misspelled" ? misspell(phrase) : phrase;
  const bg = kind === "opaqueBg" ? `<rect width="800" height="800" fill="${bad}"/>` : "";
  const shirt =
    kind === "garment"
      ? `<path d="M 250 100 L 350 60 L 400 60 L 450 100 L 550 60 L 650 140 L 580 220 L 530 190 L 530 750 L 270 750 L 270 190 L 220 220 L 150 140 Z" fill="rgb(120,120,120)" stroke="rgb(60,60,60)" stroke-width="4"/>`
      : "";
  const dx = kind === "cropped" ? 330 : 0;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="0 0 800 800">
  ${bg}
  ${shirt}
  <g transform="translate(${dx} 0)">
  ${icon(i, ink)}
  <text x="400" y="600" font-family="sans-serif" font-size="72" font-weight="bold" text-anchor="middle" fill="${ink}">${text}</text>
  </g>
</svg>`;
  const imageB64 = (await sharp(Buffer.from(svg)).png().toBuffer()).toString("base64");
  const truth = {
    garmentDrawn: kind === "garment",
    opaqueBackground: kind === "opaqueBg",
    cropped: kind === "cropped",
    phraseCorrect: kind !== "misspelled",
    inkLight: kind === "opaqueBg" ? inkLight : inkLight,
    colorMatchesArt: inkLight === (claimedColor === "Black"),
    usable: kind === "clean" || kind === "wrongInk",
  };
  return { id: `${claimedColor.toLowerCase()}-${kind}-${i}`, kind, claimedColor, phrase, visualConcept, svg, imageB64, truth };
}

const KINDS: FixtureKind[] = ["clean", "wrongInk", "garment", "cropped", "opaqueBg", "misspelled"];

/** 6 kinds x `perKind` variants per garment color (default 2 => 12 per color, 24 total). */
export async function buildFixtures(perKind = 2): Promise<Fixture[]> {
  const out: Fixture[] = [];
  for (const color of ["Black", "White"] as const) {
    for (const kind of KINDS) {
      for (let v = 0; v < perKind; v++) out.push(await build(v + KINDS.indexOf(kind), kind, color));
    }
  }
  return out;
}
