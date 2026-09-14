/**
 * Programmatic (cheap, no-Gemini-call) fix tools for the judge -> fix ->
 * judge chain (issue #14; queue wiring landed in #13, see
 * src/lib/validation-chain.ts and src/lib/design-fix.ts). Full image
 * regeneration (design-regenerate.ts, issue #15) is the expensive/slow
 * fallback — several classes of judge failure (see design-judge.ts's
 * JudgeFix / prompts.ts's imageReview() doc comment) can instead be fixed
 * here at a fraction of the cost/latency.
 *
 * Every function below is deliberately a pure-ish computation over inputs
 * it's given — no `prisma` import, no DB reads/writes — so it can be
 * exercised directly against a fixture Design/image (scripts/
 * test-design-fixes.ts) without touching the shared prod Neon DB (see
 * AGENTS.md's DB-safety note). design-fix.ts's applyProgrammaticFix() is
 * the one place that dispatches to these based on JudgeVerdict.fix and
 * turns what they return into an actual Design row update.
 */
import sharp from "sharp";
import type { Design } from "@prisma/client";
import { renderBackDesignArtwork, type BackLayout } from "./back-design";
import { removeBgB64 } from "./background-removal";

export type VariantColor = "Black" | "White";

function oppositeVariantColor(color: string | null | undefined): VariantColor {
  return (color || "Black").toLowerCase() === "black" ? "White" : "Black";
}

export type RelabelableDesign = Pick<Design, "backPhrase" | "backLayout" | "variantColor">;

export interface RelabelVariantColorResult {
  /** The design's new variantColor — always the opposite of its current
   * one. The judge only ever proposes "relabel" when the ink already reads
   * fine against the OPPOSITE claimed color (see prompts.ts's imageReview()
   * doc comment), so there is no other color to flip to. */
  variantColor: VariantColor;
  /** Re-rendered back-print composite (base64 PNG), rendered against the
   * NEW variantColor — undefined when this design has no backPhrase (there
   * is nothing to re-render). */
  backDesignImageB64?: string;
}

/**
 * "relabel" fix: flips `variantColor` to its judge-implied opposite. No
 * Gemini call, and the front art's pixels are never touched — only valid
 * when the front art's ink direction already works for the opposite color,
 * which is exactly the precondition prompts.ts's imageReview() enforces
 * before the judge ever proposes "relabel" (raster designs only — see that
 * doc comment for why "svg" designs must use "invert-ink" instead).
 *
 * If the design has a back print, it MUST be re-rendered against the new
 * color before the design is re-queued for judging: back-print ink color is
 * derived from isDarkGarment(variantColor) (back-design.ts's
 * renderBackDesignArtwork), so a stale back print would silently mismatch
 * the new garment color otherwise.
 */
export async function relabelVariantColor(
  design: RelabelableDesign,
  deps: { renderBack?: typeof renderBackDesignArtwork } = {}
): Promise<RelabelVariantColorResult> {
  const renderBack = deps.renderBack ?? renderBackDesignArtwork;
  const variantColor = oppositeVariantColor(design.variantColor);

  if (!design.backPhrase) return { variantColor };

  const backDesignImageB64 = await renderBack(design.backPhrase, {
    layout: (design.backLayout as BackLayout) || "upper-back",
    color: variantColor,
  });
  return { variantColor, backDesignImageB64 };
}

/** Thrown when invertInkColor() is called against a design whose style
 * isn't "svg" — a deliberate error, not a silent no-op/wrong-output, so a
 * caller can never mistake "we didn't invert" for "we inverted and it
 * looks fine" (see this module's top doc comment). */
export class InvertInkStyleError extends Error {}

/**
 * "invert-ink" fix: inverts the art's ink color in place — ONLY valid for
 * style === "svg" (single-color vector line art, per prompts.ts:286-290's
 * designImageArtOnly()/renderConceptArt's phrase-band compositing).
 * Inverting a multi-color raster piece would wreck it (see prompts.ts's
 * imageReview() doc comment on the raster-vs-svg "relabel" vs "invert-ink"
 * split) — callers must never call this for a raster design, and this
 * throws InvertInkStyleError rather than silently doing the wrong thing if
 * they try.
 *
 * Alpha is preserved (negate({ alpha: false })) so the transparent
 * background stays transparent — only opaque ink pixels flip light<->dark.
 * Does not touch `variantColor` and does not require a back-print re-render
 * (the back print's ink color already matches variantColor, which is
 * unchanged).
 */
export async function invertInkColor(imageB64: string, design: Pick<Design, "style">): Promise<string> {
  if (design.style !== "svg") {
    throw new InvertInkStyleError(
      `invertInkColor() only applies to "svg"-style designs (single-color vector line art) — got style=${JSON.stringify(
        design.style
      )}. Inverting a multi-color raster design would wreck it; see prompts.ts:286-290 and this module's doc comment.`
    );
  }
  const inverted = await sharp(Buffer.from(imageB64, "base64"))
    .negate({ alpha: false })
    .png()
    .toBuffer();
  return inverted.toString("base64");
}

/** Thrown when rerunBackgroundRemoval() would persist a result that's
 * measurably WORSE (less transparent, beyond ALLOWED_ALPHA_COVERAGE_REGRESSION
 * noise tolerance) than the art it started from — a real regression observed
 * against live production art during issue #14's manual real-row spot check
 * (see the issue's own comment thread), not a hypothetical: an already
 * mostly-transparent design re-run through background removal can come back
 * slightly WORSE, not just "no better". Persisting that would burn a
 * validationFixAttempts slot and return the design to the judge with the
 * identical (or a new) transparency issue — exactly the "fix that pretends
 * to succeed" failure mode design-fix.ts's doc comment says throwing exists
 * to prevent. */
export class BackgroundRemovalRegressionError extends Error {}

/** Fraction of pixels that are transparent/near-transparent (alpha < 16) —
 * the same threshold gemini.ts's measureInkLuminance uses to decide a pixel
 * counts as "ink" at all. Higher = more of the canvas correctly cleared to
 * transparent. */
async function transparentFraction(imageB64: string): Promise<number> {
  const { data, info } = await sharp(Buffer.from(imageB64, "base64"))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let transparent = 0;
  let total = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    total++;
    if (data[i + 3] < 16) transparent++;
  }
  return total === 0 ? 0 : transparent / total;
}

/** How much worse (as a fraction of total pixels) rerunBackgroundRemoval()
 * tolerates before refusing its own output — the local ONNX segmentation
 * model isn't perfectly deterministic re-run to re-run, so a hair less
 * alpha coverage than the input is tolerated as model noise rather than a
 * genuine regression. */
const ALLOWED_ALPHA_COVERAGE_REGRESSION = 0.02;

/**
 * "rerun-bg-removal" fix: re-runs the existing local background-removal
 * step (background-removal.ts's removeBgB64) for transparency/background
 * artifacts the judge flags — e.g. leftover background matter muddying the
 * ink, or a background that never actually went transparent. A thin wrapper
 * (not just a re-export of removeBgB64) so design-fix.ts's dispatch table
 * reads uniformly alongside relabelVariantColor/invertInkColor, and so a
 * test can inject a fake remover instead of paying for a real ONNX pass.
 *
 * Measures transparent-pixel coverage before and after and throws
 * BackgroundRemovalRegressionError rather than returning a result that's
 * measurably worse than what it started from — see that error's doc
 * comment. This directly enforces this fix's own contract (issue #14: "an
 * image with improved/equal alpha coverage vs. the input"), rather than
 * trusting removeBgB64 to always uphold it.
 */
export async function rerunBackgroundRemoval(
  imageB64: string,
  deps: { removeBg?: typeof removeBgB64 } = {}
): Promise<string> {
  const removeBg = deps.removeBg ?? removeBgB64;
  const before = await transparentFraction(imageB64);
  const cleaned = await removeBg(imageB64);
  const after = await transparentFraction(cleaned);

  if (after < before - ALLOWED_ALPHA_COVERAGE_REGRESSION) {
    throw new BackgroundRemovalRegressionError(
      `rerunBackgroundRemoval() made transparency WORSE, not better — ` +
        `${(before * 100).toFixed(1)}% -> ${(after * 100).toFixed(1)}% transparent pixel coverage. ` +
        `Refusing to persist a fix that doesn't fix anything.`
    );
  }

  return cleaned;
}
