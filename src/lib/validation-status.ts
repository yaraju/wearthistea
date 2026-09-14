/**
 * Design.validationStatus lifecycle helpers — see prisma/schema.prisma's
 * comment on that column (issue #11) for the full state machine:
 * unjudged | pending | validating | regenerating | validated | superseded |
 * rejected.
 *
 * Kept as a plain module (no "use client", no framer-motion/lucide-react
 * imports) so it can be exercised by a Node script (scripts/test-poll-
 * stop-condition.ts) without dragging in React/browser-only deps, and
 * shared between KeywordStudio.tsx's poll-stop condition and its mount-
 * restore effect so the two can't drift apart.
 */

/** Every value the column can currently hold. Exported for #13/#18/#19 to
 * import rather than re-typing the literal list. */
export const VALIDATION_STATUSES = [
  "unjudged",
  "pending",
  "validating",
  "regenerating",
  "validated",
  "superseded",
  "rejected",
] as const;

export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];

// The states a design can cycle through *while the judge/fix loop is
// actively working it* — a batch should keep polling as long as any design
// is in one of these. Deliberately a small "in-flight" allowlist rather than
// a large "settled" allowlist: any status we've never heard of (a future
// addition, or a stale/partial response missing the field entirely) is
// treated as settled by default, so polling stops instead of spinning
// forever. This does mean "validated | rejected | unjudged" (the issue's
// literal terminal list) isn't the only thing that stops polling — so does
// "superseded" (set on a design once #13's regeneration flow supersedes it
// with a new row) and any other status not listed below. That's intentional:
// a superseded design is done changing, same as validated/rejected.
const IN_FLIGHT_VALIDATION_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "validating",
  "regenerating",
]);

/** True while `status` means the judge/fix loop is still actively working
 * this design (so the badge should stay up and polling should continue). */
export function isValidationInFlight(status: string | null | undefined): boolean {
  return status != null && IN_FLIGHT_VALIDATION_STATUSES.has(status);
}

/** Poll-stop predicate for a batch: stop once every design has reached a
 * terminal `status` (not "generating") AND no design's `validationStatus`
 * is still in flight. Shared by pollBatchStatus() and the mount-restore
 * effect in KeywordStudio.tsx — both need to keep polling through
 * pending/validating/regenerating, not just through "generating" art
 * rendering. */
export function shouldStopPolling(
  designs: readonly { status: string; validationStatus?: string | null }[]
): boolean {
  return !designs.some(
    (d) => d.status === "generating" || isValidationInFlight(d.validationStatus)
  );
}
