/**
 * Unit test for judgeDesign() (src/lib/design-judge.ts, issue #12) against
 * fixture images. Makes REAL Gemini multimodal judge calls (there's no
 * offline fallback in judgeDesign() by design — see its doc comment) so
 * this needs GEMINI_API_KEY set; costs a few real API calls.
 *
 * Three fixtures:
 *  1. Clean design, claimed color matches ink direction — should pass.
 *  2. Visibly mismatched ink-vs-claimed-color — should come back with
 *     colorMatchesArt: false and fix "relabel" (raster) or "invert-ink"
 *     (svg), depending on style.
 *  3. A drawn garment/mockup (crude t-shirt silhouette) composited into the
 *     print graphic — should come back usable: false.
 *
 * Usage: npx tsx scripts/test-design-judge.ts
 * Exits non-zero if any assertion fails.
 */
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const { judgeDesign } = await import("../src/lib/design-judge");
  const sharp = (await import("sharp")).default;

  let failures = 0;
  function check(label: string, ok: boolean, detail?: string) {
    console.log(`  [${ok ? "ok" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures++;
  }

  // Fixture builder: renders one self-contained SVG (a filled circle "icon"
  // plus the literal phrase as real legible text, all in `rgb`) straight to
  // PNG on a transparent canvas — deterministic, no network call, no binary
  // fixture to check in. Keeping the "visual" deliberately trivial (always
  // "a single bold filled circle") means judgeDesign()'s illustration-
  // fidelity judgment stays a non-factor, isolating what this test actually
  // targets: the color-fitness (colorMatchesArt/fix) and garment-in-graphic
  // (usable) checks.
  async function fixtureImage(
    rgb: { r: number; g: number; b: number },
    phrase: string,
    opts: { withGarment?: boolean } = {}
  ): Promise<string> {
    const ink = `rgb(${rgb.r},${rgb.g},${rgb.b})`;
    // Crude but unmistakable t-shirt silhouette (body + two sleeves + collar
    // notch), only added for the garment-in-graphic fixture.
    const shirt = opts.withGarment
      ? `<path d="M 250 100 L 350 60 L 400 60 L 450 100 L 550 60 L 650 140 L 580 220 L 530 190 L 530 750 L 270 750 L 270 190 L 220 220 L 150 140 Z"
           fill="rgb(90,90,90)" stroke="black" stroke-width="4" />`
      : "";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800">
      ${shirt}
      <circle cx="400" cy="330" r="140" fill="${ink}" />
      <text x="400" y="600" font-family="sans-serif" font-size="72" font-weight="bold"
            text-anchor="middle" fill="${ink}">${phrase}</text>
    </svg>`;
    const buf = await sharp(Buffer.from(svg)).png().toBuffer();
    return buf.toString("base64");
  }

  // ── Fixture 1: clean design, color matches ink direction ────────────────
  console.log("=== Fixture 1: clean design (light ink, claimed Black) ===");
  const cleanImage = await fixtureImage({ r: 245, g: 245, b: 245 }, "OK"); // light ink
  const cleanVerdict = await judgeDesign(
    {
      phrase: "OK",
      visualConcept: "A single bold filled circle icon, with the shirt phrase printed as bold text beneath it.",
      style: "raster",
    },
    cleanImage,
    "Black" // Black garment needs light ink — matches
  );
  console.log("  verdict:", JSON.stringify(cleanVerdict));
  check("usable: true", cleanVerdict.usable === true);
  check("colorMatchesArt: true", cleanVerdict.colorMatchesArt === true);
  check("fix: none", cleanVerdict.fix === "none", `got "${cleanVerdict.fix}"`);
  check(
    "measuredInkLuminance reads as light (>127.5)",
    cleanVerdict.measuredInkLuminance !== null && cleanVerdict.measuredInkLuminance > 127.5
  );

  // ── Fixture 2a: color mismatch, raster pipeline -> expect "relabel" ─────
  console.log("\n=== Fixture 2a: mismatched ink/color, raster style (light ink, claimed White) ===");
  const mismatchImage = await fixtureImage({ r: 245, g: 245, b: 245 }, "NO CAP"); // light ink
  const mismatchRaster = await judgeDesign(
    {
      phrase: "NO CAP",
      visualConcept: "A single bold filled circle icon, with the shirt phrase printed as bold text beneath it.",
      style: "raster",
    },
    mismatchImage,
    "White" // White garment needs dark ink — this is light ink, mismatch
  );
  console.log("  verdict:", JSON.stringify(mismatchRaster));
  check("colorMatchesArt: false", mismatchRaster.colorMatchesArt === false);
  check(
    'fix is "relabel" or "invert-ink"',
    mismatchRaster.fix === "relabel" || mismatchRaster.fix === "invert-ink",
    `got "${mismatchRaster.fix}"`
  );

  // ── Fixture 2b: same mismatch, svg pipeline -> "relabel" should be avoided
  console.log("\n=== Fixture 2b: mismatched ink/color, svg style (light ink, claimed White) ===");
  const mismatchSvg = await judgeDesign(
    {
      phrase: "NO CAP",
      visualConcept: "A single bold filled circle icon, with the shirt phrase printed as bold text beneath it.",
      style: "svg",
    },
    mismatchImage,
    "White"
  );
  console.log("  verdict:", JSON.stringify(mismatchSvg));
  check("colorMatchesArt: false", mismatchSvg.colorMatchesArt === false);
  check('fix is NOT "relabel" for an svg design', mismatchSvg.fix !== "relabel", `got "${mismatchSvg.fix}"`);

  // ── Fixture 3: drawn garment/mockup in the graphic -> usable: false ──────
  console.log("\n=== Fixture 3: garment/mockup drawn into the print graphic ===");
  const garmentImage = await fixtureImage({ r: 10, g: 10, b: 10 }, "TEA", { withGarment: true });
  const garmentVerdict = await judgeDesign(
    {
      phrase: "TEA",
      visualConcept: "A single bold filled circle icon, with the shirt phrase printed as bold text beneath it.",
      style: "raster",
    },
    garmentImage,
    "White"
  );
  console.log("  verdict:", JSON.stringify(garmentVerdict));
  check("usable: false", garmentVerdict.usable === false);
  check(
    "issues mentions a garment/shirt/collar/mockup",
    garmentVerdict.issues.some((i) => /t-?shirt|mockup|garment|collar|sleeve/i.test(i)),
    JSON.stringify(garmentVerdict.issues)
  );

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("ERROR", err);
  process.exitCode = 1;
});
