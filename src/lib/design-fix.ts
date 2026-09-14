/**
 * #14 STUB — not implemented yet.
 *
 * judge-design (issue #13's chain, see src/lib/validation-chain.ts's
 * runFixStep()) routes here for the three cheap-fix verdicts judgeDesign()
 * can return (src/lib/design-judge.ts's JudgeFix): "relabel" (correct
 * Design.variantColor metadata to match the art's actual ink direction,
 * raster designs only), "invert-ink" (recolor the raster art's ink pixels
 * in place), or "rerun-bg-removal" (re-run background/alpha cleanup). See
 * prompts.imageReview()'s doc comment for exactly when each applies,
 * particularly the raster-vs-svg distinction between relabel and
 * invert-ink.
 *
 * Signature is fixed by issue #13 so #14 can implement this in place
 * without touching any caller: runFixStep() awaits this, expects it to
 * either mutate `design`'s stored artwork/row in place and return
 * normally, or throw to signal the fix genuinely failed.
 *
 * Throwing here (instead of silently no-op'ing "success") is deliberate: a
 * fix that pretends to succeed without changing anything would burn one of
 * the two validationFixAttempts budget slots for nothing, invisibly to
 * whoever's debugging why a design keeps landing back at the judge with the
 * same issue. runFixStep() treats a thrown error as a transient task
 * failure — fix-design/route.ts returns a 5xx so Cloud Tasks retries per
 * the design-fix queue's own backoff config, and leaves the design's
 * validationStatus at "regenerating" (unchanged, attempt counter already
 * incremented by judge-design before this was ever called) rather than
 * advancing it — so nothing is lost, the row just sits correctly "in
 * flight" until #14 lands.
 */
import type { Design } from "@prisma/client";
import type { JudgeVerdict } from "./design-judge";

export class NotImplementedError extends Error {}

export async function applyProgrammaticFix(design: Design, verdict: JudgeVerdict): Promise<void> {
  throw new NotImplementedError(
    `applyProgrammaticFix() is not implemented yet (issue #14) — design ${design.id}, fix="${verdict.fix}".`
  );
}
