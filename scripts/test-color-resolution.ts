/**
 * Unit/integration test for the garment-color resolution logic added by
 * issue #10 (image generation chooses & self-reports garment color).
 *
 * No live Gemini calls, no DB writes — purely exercises
 * resolveGarmentColor()/resolveGarmentColorFromLuminance() (src/lib/gemini.ts)
 * against fixture text + fixture images built locally with sharp, mirroring
 * COLOR_CHOICE, the token designImage()/designImageArtOnly() (src/config/
 * prompts.ts) instruct the image model to end its response with.
 *
 * Usage: npx tsx scripts/test-color-resolution.ts
 * Exits non-zero if any assertion fails.
 */
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const { resolveGarmentColor, resolveGarmentColorFromLuminance } = await import("../src/lib/gemini");
  const sharp = (await import("sharp")).default;

  let failures = 0;
  function assertEqual(label: string, actual: unknown, expected: unknown) {
    const ok = actual === expected;
    console.log(`  [${ok ? "ok" : "FAIL"}] ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    if (!ok) failures++;
  }

  // A tiny 1x1 transparent PNG — irrelevant to these cases since a valid
  // COLOR_CHOICE token should be trusted without inspecting pixels at all.
  const BLANK_PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  // Fixture image builder: a transparent canvas with an opaque square of
  // `rgb` composited in the middle — simulates the actual non-transparent
  // "ink" pixels renderConceptArt's luminance fallback measures.
  async function fixtureImage(rgb: { r: number; g: number; b: number }): Promise<string> {
    const buf = await sharp({
      create: { width: 200, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 100, height: 100, channels: 4, background: { ...rgb, alpha: 1 } },
          })
            .png()
            .toBuffer(),
          left: 50,
          top: 50,
        },
      ])
      .png()
      .toBuffer();
    return buf.toString("base64");
  }

  console.log("=== COLOR_CHOICE token parsing ===");

  // 1) Well-formed token, as the LAST line of a realistic multi-line response.
  const whiteText = "Some incidental prose the model might emit.\nCOLOR_CHOICE: white";
  assertEqual(
    'given "COLOR_CHOICE: white" as the last line, resolves to "White"',
    await resolveGarmentColor(whiteText, BLANK_PNG_B64),
    "White"
  );

  const blackText = "COLOR_CHOICE: black";
  assertEqual(
    'given "COLOR_CHOICE: black", resolves to "Black"',
    await resolveGarmentColor(blackText, BLANK_PNG_B64),
    "Black"
  );

  // 2) Token with trailing whitespace/casing noise — still strict-matches.
  assertEqual(
    "tolerates trailing whitespace",
    await resolveGarmentColor("COLOR_CHOICE: white   ", BLANK_PNG_B64),
    "White"
  );

  console.log("\n=== Luminance fallback (no parseable token) ===");

  // 3) No text at all (the Imagen path never returns text) + light ink
  // (near-white) → should read as ink drawn for a BLACK garment.
  const lightInkImage = await fixtureImage({ r: 245, g: 245, b: 245 });
  const lightInkResult = await resolveGarmentColor(undefined, lightInkImage);
  assertEqual("light ink (near-white) fixture falls back to luminance and resolves Black", lightInkResult, "Black");

  // 4) Dark ink (near-black) → should read as ink drawn for a WHITE garment.
  const darkInkImage = await fixtureImage({ r: 10, g: 10, b: 10 });
  const darkInkResult = await resolveGarmentColor(undefined, darkInkImage);
  assertEqual("dark ink (near-black) fixture falls back to luminance and resolves White", darkInkResult, "White");

  // 5) Malformed token (doesn't match the strict regex) also falls back,
  // rather than silently matching something looser.
  const malformedResult = await resolveGarmentColor("the color is definitely white I promise", lightInkImage);
  assertEqual("malformed/unparseable text falls back to luminance (Black, from light ink)", malformedResult, "Black");

  // 6) Determinism: same fixture pixels -> same resolved color, every time.
  const repeat1 = await resolveGarmentColorFromLuminance(lightInkImage);
  const repeat2 = await resolveGarmentColorFromLuminance(lightInkImage);
  assertEqual("luminance fallback is deterministic across repeated calls", repeat1, repeat2);
  assertEqual("...and matches the earlier resolution for the same fixture", repeat1, lightInkResult);

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("ERROR", err);
  process.exitCode = 1;
});
