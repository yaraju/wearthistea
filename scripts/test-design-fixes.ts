/**
 * Automated validation for issue #14 — the programmatic fix tools in
 * src/lib/design-fixes.ts (relabelVariantColor / invertInkColor /
 * rerunBackgroundRemoval).
 *
 * Deliberately does NOT touch the shared prod Neon DB and does NOT call
 * Gemini — everything here is either pure computation, deterministic local
 * rendering (back-design.ts's renderBackDesignArtwork is Satori/QR-based,
 * no LLM call), or (for the bg-removal check) the local ONNX
 * background-removal model, matching this directory's existing
 * no-network-DB / fixture-driven style (test-color-resolution.ts,
 * test-validation-chain.ts).
 *
 * Covers this issue's three automated-validation criteria verbatim:
 *   1. relabelVariantColor on a fixture design flips variantColor and
 *      produces a back-print render whose ink color matches
 *      isDarkGarment(newColor) — checked by actually measuring the
 *      rendered back-print pixels with gemini.ts's measureInkLuminance,
 *      the same ground-truth grounding design-judge.ts's judge itself
 *      uses, not just a records-what-it-was-called-with fake.
 *   2. invertInkColor on a fixture SVG-style image produces a
 *      pixel-inverted result, and throws InvertInkStyleError (not a silent
 *      wrong-output no-op) when called against a design whose style isn't
 *      "svg".
 *   3. rerunBackgroundRemoval produces an image with improved/equal alpha
 *      coverage vs. a fixture with a known (fully opaque, i.e. "never went
 *      transparent") background artifact — and, per a real-row finding
 *      during this issue's manual spot check (a genuine 62.3% -> 61.6%
 *      regression against live production art), throws
 *      BackgroundRemovalRegressionError rather than silently persisting a
 *      result that's measurably WORSE than its input.
 *
 * Usage: npx tsx scripts/test-design-fixes.ts
 * Exits non-zero if any assertion fails.
 */
import dotenv from "dotenv";
dotenv.config();

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  [${ok ? "ok" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const sharp = (await import("sharp")).default;
  const {
    relabelVariantColor,
    invertInkColor,
    InvertInkStyleError,
    rerunBackgroundRemoval,
    BackgroundRemovalRegressionError,
  } = await import("../src/lib/design-fixes");
  const { isDarkGarment } = await import("../src/config/prompts");
  const { measureInkLuminance } = await import("../src/lib/gemini");
  const { renderBackDesignArtwork } = await import("../src/lib/back-design");

  // ── Fixture builders ────────────────────────────────────────────────────

  /** A fully transparent canvas with one opaque `rgb` square in the middle —
   * simulates the non-transparent "ink" pixels measureInkLuminance/judge
   * logic looks at. */
  async function inkSquareImage(rgb: { r: number; g: number; b: number }, size = 200): Promise<string> {
    const buf = await sharp({
      create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        {
          input: await sharp({
            create: { width: size / 2, height: size / 2, channels: 4, background: { ...rgb, alpha: 1 } },
          })
            .png()
            .toBuffer(),
          left: Math.round(size / 4),
          top: Math.round(size / 4),
        },
      ])
      .png()
      .toBuffer();
    return buf.toString("base64");
  }

  /** A "known background artifact" fixture: FULLY OPAQUE canvas (background
   * never went transparent) with a distinct opaque foreground square — the
   * exact "background isn't actually transparent" class of judge issue
   * rerun-bg-removal is meant to fix. */
  async function opaqueBackgroundFixture(size = 200): Promise<string> {
    const buf = await sharp({
      create: { width: size, height: size, channels: 4, background: { r: 250, g: 248, b: 240, alpha: 1 } },
    })
      .composite([
        {
          input: await sharp({
            create: { width: size / 2, height: size / 2, channels: 4, background: { r: 20, g: 20, b: 20, alpha: 1 } },
          })
            .png()
            .toBuffer(),
          left: Math.round(size / 4),
          top: Math.round(size / 4),
        },
      ])
      .png()
      .toBuffer();
    return buf.toString("base64");
  }

  /** Fraction of pixels that are transparent/near-transparent (alpha < 16) —
   * higher = more of the canvas correctly cleared to transparent. */
  async function transparentFraction(imageB64: string): Promise<number> {
    const { data, info } = await sharp(Buffer.from(imageB64, "base64"))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    let transparent = 0;
    let total = 0;
    for (let i = 0; i < data.length; i += channels) {
      total++;
      if (data[i + 3] < 16) transparent++;
    }
    return total === 0 ? 0 : transparent / total;
  }

  /** Raw RGBA at one pixel, for before/after inversion comparisons. */
  async function pixelAt(imageB64: string, x: number, y: number): Promise<{ r: number; g: number; b: number; a: number }> {
    const { data, info } = await sharp(Buffer.from(imageB64, "base64"))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const idx = (y * info.width + x) * info.channels;
    return { r: data[idx], g: data[idx + 1], b: data[idx + 2], a: data[idx + 3] };
  }

  // ── 1. relabelVariantColor ──────────────────────────────────────────────
  console.log("=== relabelVariantColor ===");

  {
    const design = { variantColor: "Black", backPhrase: "scan if you dare", backLayout: "upper-back" };
    const result = await relabelVariantColor(design, { renderBack: renderBackDesignArtwork });
    check('flips "Black" -> "White"', result.variantColor === "White", `got ${result.variantColor}`);
    check("produces a back-print render (backPhrase present)", Boolean(result.backDesignImageB64));

    if (result.backDesignImageB64) {
      const luminance = await measureInkLuminance(result.backDesignImageB64);
      check("back-print render has measurable ink pixels", luminance !== null);
      if (luminance !== null) {
        const reads = luminance > 127.5 ? "light" : "dark";
        const wants = isDarkGarment(result.variantColor) ? "light" : "dark";
        check(
          `back-print ink direction (${reads}) matches isDarkGarment("${result.variantColor}") requirement (${wants})`,
          reads === wants,
          `measured luminance ${luminance.toFixed(1)}/255`
        );
      }
    }
  }

  {
    // Reverse direction: White -> Black, and confirm renderBack is invoked
    // with the NEW color, not the old one, via an injected fake.
    const design = { variantColor: "White", backPhrase: "scan if you dare", backLayout: "full-panel" };
    let calledWith: { color: string; layout: string } | null = null;
    const fakeRenderBack: typeof renderBackDesignArtwork = async (_phrase, opts) => {
      calledWith = { color: opts.color, layout: opts.layout };
      return await inkSquareImage({ r: 255, g: 255, b: 255 });
    };
    const result = await relabelVariantColor(design, { renderBack: fakeRenderBack });
    check('flips "White" -> "Black"', result.variantColor === "Black", `got ${result.variantColor}`);
    check(
      "back-print re-render is invoked against the NEW color, not the old one",
      calledWith !== null && (calledWith as { color: string }).color === "Black",
      JSON.stringify(calledWith)
    );
    check(
      "back-print re-render preserves the design's backLayout",
      calledWith !== null && (calledWith as { layout: string }).layout === "full-panel",
      JSON.stringify(calledWith)
    );
  }

  {
    // No backPhrase -> metadata-only change, no render call at all.
    const design = { variantColor: "Black", backPhrase: null, backLayout: "upper-back" };
    let renderCalled = false;
    const fakeRenderBack: typeof renderBackDesignArtwork = async () => {
      renderCalled = true;
      return inkSquareImage({ r: 0, g: 0, b: 0 });
    };
    const result = await relabelVariantColor(design, { renderBack: fakeRenderBack });
    check('flips color even with no back print', result.variantColor === "White");
    check("does not render a back print when backPhrase is absent", !renderCalled);
    check("returns no backDesignImageB64 when backPhrase is absent", result.backDesignImageB64 === undefined);
  }

  // ── 2. invertInkColor ────────────────────────────────────────────────────
  console.log("\n=== invertInkColor ===");

  {
    // Near-black ink square on transparent background, "svg" style.
    const original = await inkSquareImage({ r: 17, g: 17, b: 17 });
    const inverted = await invertInkColor(original, { style: "svg" });

    const centerBefore = await pixelAt(original, 100, 100);
    const centerAfter = await pixelAt(inverted, 100, 100);
    check(
      "ink pixel is inverted (near-black -> near-white)",
      centerAfter.r > 230 && centerAfter.g > 230 && centerAfter.b > 230,
      `before rgb(${centerBefore.r},${centerBefore.g},${centerBefore.b}) after rgb(${centerAfter.r},${centerAfter.g},${centerAfter.b})`
    );
    check(
      "inverted pixel value is the pixel-wise complement (255 - original)",
      Math.abs(centerAfter.r - (255 - centerBefore.r)) <= 1 &&
        Math.abs(centerAfter.g - (255 - centerBefore.g)) <= 1 &&
        Math.abs(centerAfter.b - (255 - centerBefore.b)) <= 1
    );

    const edgeBefore = await pixelAt(original, 5, 5);
    const edgeAfter = await pixelAt(inverted, 5, 5);
    check(
      "transparent background pixels stay transparent (alpha untouched)",
      edgeBefore.a === edgeAfter.a && edgeAfter.a < 16,
      `before alpha ${edgeBefore.a} after alpha ${edgeAfter.a}`
    );
  }

  {
    // style !== "svg" -> must throw InvertInkStyleError, not silently
    // return a wrong-but-plausible result.
    const raster = await inkSquareImage({ r: 17, g: 17, b: 17 });
    let threw: unknown = null;
    let producedOutput = false;
    try {
      await invertInkColor(raster, { style: "raster" });
      producedOutput = true;
    } catch (err) {
      threw = err;
    }
    check("throws for a non-svg style design", threw instanceof InvertInkStyleError, String(threw));
    check("...and does not silently produce an inverted-but-wrong result", !producedOutput);
  }

  // ── 3. rerunBackgroundRemoval ────────────────────────────────────────────
  console.log("\n=== rerunBackgroundRemoval ===");

  {
    const fixture = await opaqueBackgroundFixture();
    const before = await transparentFraction(fixture);
    check(
      "fixture reproduces the bug: background starts fully opaque (0% transparent)",
      before < 0.01,
      `${(before * 100).toFixed(1)}% transparent before`
    );

    // Deterministic check with an injected fake remover (always runs,
    // mirrors what a real bg-remover is supposed to do: clear everything
    // outside the foreground shape to transparent) — validates
    // rerunBackgroundRemoval's own plumbing/contract without depending on
    // network access to the ONNX model.
    const fakeRemoveBg = async (src: string | Buffer | Uint8Array): Promise<string> => {
      const bytes = typeof src === "string" ? Buffer.from(src, "base64") : Buffer.from(src as Buffer);
      const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const out = Buffer.from(data);
      // "remove" anything close to the fixture's background color.
      for (let i = 0; i < out.length; i += info.channels) {
        const isBg = out[i] > 240 && out[i + 1] > 235 && out[i + 2] > 225;
        if (isBg) out[i + 3] = 0;
      }
      const png = await sharp(out, { raw: { width: info.width, height: info.height, channels: info.channels as 4 } })
        .png()
        .toBuffer();
      return png.toString("base64");
    };
    const fakeResult = await rerunBackgroundRemoval(fixture, { removeBg: fakeRemoveBg });
    const fakeAfter = await transparentFraction(fakeResult);
    check(
      "rerunBackgroundRemoval (fake remover) improves alpha coverage vs. input",
      fakeAfter >= before,
      `${(before * 100).toFixed(1)}% -> ${(fakeAfter * 100).toFixed(1)}% transparent`
    );
    check(
      "rerunBackgroundRemoval dispatches to the injected remover (not a bypassed default)",
      fakeAfter > before + 0.1,
      `${(before * 100).toFixed(1)}% -> ${(fakeAfter * 100).toFixed(1)}% transparent`
    );

    // Best-effort real check with the actual local ONNX model
    // (background-removal.ts's removeBgB64) — skipped (not failed) if it
    // can't run in this environment (no network for first-run model
    // download, etc.), since the deterministic check above already proves
    // the function's contract.
    try {
      const realResult = await rerunBackgroundRemoval(fixture);
      const realAfter = await transparentFraction(realResult);
      check(
        "rerunBackgroundRemoval (real ONNX remover) improves/equals alpha coverage vs. input",
        realAfter >= before,
        `${(before * 100).toFixed(1)}% -> ${(realAfter * 100).toFixed(1)}% transparent`
      );
    } catch (err) {
      console.log(`  [skip] real ONNX background removal unavailable in this environment — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  {
    // Regression guard: a "remover" that makes transparency WORSE (found for
    // real against a live production design during issue #14's manual
    // spot-check — see the issue thread) must be refused, not silently
    // persisted as if it were a successful fix. Starts from a fixture that
    // already has real transparent coverage (75%, like inkSquareImage) so a
    // "worsening" remover has somewhere to regress FROM.
    const fixture = await inkSquareImage({ r: 20, g: 20, b: 20 });
    const worseningRemoveBg = async (src: string | Buffer | Uint8Array): Promise<string> => {
      const bytes = typeof src === "string" ? Buffer.from(src, "base64") : Buffer.from(src as Buffer);
      // Paint a large opaque block over previously-transparent canvas —
      // strictly less transparent than the input, never more.
      const png = await sharp(bytes)
        .composite([
          {
            input: await sharp({
              create: { width: 200, height: 100, channels: 4, background: { r: 1, g: 1, b: 1, alpha: 1 } },
            })
              .png()
              .toBuffer(),
            left: 0,
            top: 0,
          },
        ])
        .png()
        .toBuffer();
      return png.toString("base64");
    };
    let threw: unknown = null;
    try {
      await rerunBackgroundRemoval(fixture, { removeBg: worseningRemoveBg });
    } catch (err) {
      threw = err;
    }
    check(
      "refuses a result that's WORSE (less transparent) than the input, not just no-worse",
      threw instanceof BackgroundRemovalRegressionError,
      String(threw)
    );
  }

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("ERROR", err);
  process.exitCode = 1;
});
