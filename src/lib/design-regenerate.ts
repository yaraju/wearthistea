/**
 * #15 STUB — today a pure passthrough.
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
 * one) and is safe to run for real today.
 *
 * What's NOT implemented yet is making the regeneration actually smarter:
 * this function ignores `verdict.regenerationPrompt` entirely and just
 * copies the source design's concept text verbatim, which means a sibling
 * built from this has essentially the same odds of passing the judge as the
 * design that just failed it. That's expected and, for now, desired — it's
 * exactly what lets the "fails every attempt" chain test reach "rejected"
 * deterministically after exactly one regen cycle instead of looping.
 *
 * #15's job: use verdict.regenerationPrompt (and/or verdict.issues) to
 * actually rewrite visualConcept/designPrompt/productPrompt into something
 * with a real chance of passing, before runRegenerateStep() persists it
 * onto the new sibling row.
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

export function buildRegenerationConcept(
  source: RegenerationSourceDesign,
  verdict: JudgeVerdict
): RegenerationConcept {
  void verdict; // not yet used — see doc comment above; #15 will consult it.
  return {
    title: source.title,
    phrase: source.phrase,
    visualConcept: source.visualConcept,
    designPrompt: source.designPrompt,
    productPrompt: source.productPrompt,
  };
}
