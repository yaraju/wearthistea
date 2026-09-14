/**
 * #15 — targeted image-to-image regeneration for design-judge fixes.
 *
 * judge-design (issue #13's chain, see src/lib/validation-chain.ts's
 * runRegenerateStep()) routes here when judgeDesign()'s `fix` field is
 * "regenerate" (or the cheap-fix budget is exhausted and a regen attempt is
 * still available). Unlike design-fix.ts's applyProgrammaticFix() stub,
 * runRegenerateStep() does NOT stub out the mechanical sibling-creation +
 * render — that part is proven prior art (mirrors
 * design-judge-bulk.ts's flagAndTriggerStuckDesign() and
 * /api/admin/designs/[id]/regenerate/route.ts's sibling-creation, per issue
 * #13's own instruction to reuse that precedent rather than invent a new
 * one).
 *
 * This module has two exported pieces, split along the same "what to say"
 * (RegenerationConcept, computed here) vs. "what pixels to change" (image
 * edit, computed here as an instruction string but actually EXECUTED by
 * gemini.ts's renderConceptArtFix() via design-render.ts's
 * renderDesignArtwork(..., edit)) split that the rest of this pipeline
 * already uses:
 *
 * - buildRegenerationConcept(): still a deliberate metadata PASSTHROUGH —
 *   title/phrase/visualConcept/designPrompt/productPrompt are copied
 *   verbatim from the source design onto the new sibling row. This is
 *   intentional, not a leftover stub: issue #15's fix is a targeted
 *   image-to-image EDIT of the source's actual rendered pixels (see
 *   buildRegenerationEdit()/renderConceptArtFix() below), not a
 *   text-conditioned from-scratch re-roll — the concept description that
 *   produced the original art hasn't changed, so there is nothing for this
 *   function to rewrite. (An earlier draft of this module's doc comment
 *   described a different, text-rewriting architecture; the image-to-image
 *   approach below is what issue #15's actual scope asked for and is what
 *   shipped.)
 * - buildRegenerationEdit(): turns a JudgeVerdict into the targeted edit
 *   instruction (prompts.designImageFix()'s `instruction` argument) paired
 *   with the source design's CURRENT image — validation-chain.ts's
 *   defaultRegenerateRenderFn() is what actually loads that source image
 *   (via loadDesignImageBase64()) and calls renderDesignArtwork() with it.
 */
import type { Design } from "@prisma/client";
import type { JudgeVerdict } from "./design-judge";

export type RegenerationSourceDesign = Pick<
  Design,
  "title" | "phrase" | "visualConcept" | "designPrompt" | "productPrompt"
>;

export interface RegenerationConcept {
  title: string;
  phrase: string;
  visualConcept: string;
  designPrompt: string;
  productPrompt: string;
}

/**
 * Deliberate metadata passthrough — see this module's top doc comment for
 * why. The sibling row still needs its own title/phrase/visualConcept/
 * designPrompt/productPrompt (renderDesignArtwork() rebuilds its Concept
 * from these fields regardless of the `edit` path), so this stays the one
 * place that shape gets assembled, even though today it doesn't vary it
 * based on `verdict`.
 */
export function buildRegenerationConcept(
  source: RegenerationSourceDesign,
  verdict: JudgeVerdict
): RegenerationConcept {
  void verdict; // the fix lives in the pixels (buildRegenerationEdit below), not the text.
  return {
    title: source.title,
    phrase: source.phrase,
    visualConcept: source.visualConcept,
    designPrompt: source.designPrompt,
    productPrompt: source.productPrompt,
  };
}

export interface RegenerationEdit {
  /** Targeted instruction paired with the source design's CURRENT image as
   * an image-to-image edit request — prompts.designImageFix()'s
   * `instruction` argument, NOT a from-scratch re-roll prompt. Prefers the
   * judge's own regenerationPrompt verbatim (design-judge.ts's
   * judgeDesign() already writes this as "a concise corrected prompt" when
   * it proposes fix: "regenerate" — see imageReview()'s doc comment/schema
   * in src/config/prompts.ts); falls back to a generic instruction built
   * from verdict.issues only in the defensive case where regenerationPrompt
   * came back empty (imageReviewSchema requires the field, but a model can
   * still violate its own schema's intent in the wild). */
  instruction: string;
}

/**
 * Pure (no DB, no Gemini call) — turns a JudgeVerdict into the instruction
 * renderConceptArtFix() pairs with the source design's current image. Split
 * out from buildRegenerationConcept() so it's directly unit-testable
 * without a fixture Design row (see scripts/test-design-regenerate.ts).
 */
export function buildRegenerationEdit(verdict: JudgeVerdict): RegenerationEdit {
  const prompt = verdict.regenerationPrompt?.trim();
  if (prompt) return { instruction: prompt };

  const issues = verdict.issues.filter(Boolean);
  const instruction =
    issues.length > 0
      ? `Fix the following issues found during quality review: ${issues.join("; ")}.`
      : "Fix the issues found during quality review and make the artwork fully usable.";
  return { instruction };
}
