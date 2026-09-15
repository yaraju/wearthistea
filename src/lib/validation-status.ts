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

/**
 * Minimal shape mergePolledDesigns() needs from a design row — a lean
 * subset of DesignDTO (src/lib/types.ts), kept separate so this module
 * stays a plain function over plain data rather than importing that type.
 */
export interface PollableDesign {
  id: string;
  validationStatus?: string | null;
  regeneratedFromDesignId?: string | null;
}

/**
 * Merges a freshly-polled batch onto the client's existing grid slots
 * (issue #32). `prevDesigns` is the fixed set of ids/slots KeywordStudio.tsx
 * learned about from the original /api/generate call; `polledDesigns` is
 * the FLAT array /api/generate/status just returned for the whole batch —
 * that endpoint queries by batchId, not by id list, so it also includes any
 * sibling rows the judge/fix/regenerate chain (issue #13) has since created.
 *
 * For each slot, this finds the same-id row in polledDesigns (today's
 * behavior), then — if THAT row's validationStatus is "superseded" (the
 * chain replaced it with a new sibling row rather than mutating it in
 * place) — walks forward via regeneratedFromDesignId to find the sibling
 * created from it, and repeats, however many hops deep: a sibling can
 * itself later be superseded by a subsequent regeneration. Same principle
 * as design-versions.ts's resolveLatestDesignVersion(), reimplemented here
 * as a client-side walk over a flat array already in hand, since there's no
 * Prisma relation to walk on the client.
 *
 * Never throws: if a superseded design's sibling hasn't landed in this
 * particular poll response yet (still "regenerating", or a payload that for
 * some reason omits it), this keeps whatever was resolved so far — the next
 * poll will pick the sibling up once it exists. A design that was never
 * superseded, or whose id no longer appears in polledDesigns at all, is
 * untouched (matches the pre-#32 behavior exactly).
 *
 * The returned slot always carries the RESOLVED design's own fields
 * (id, validationStatus, image paths, ...), so a caller like
 * KeywordStudio's ValidationBadge naturally reflects the sibling's own
 * in-flight state — no separate pass needed.
 *
 * De-dupes by resolved id, keeping the FIRST slot that resolves to a given
 * id and dropping any later one. This matters for KeywordStudio's
 * mount-restore effect, which seeds `prevDesigns` straight from a raw
 * /api/generate/status payload (every row for the batch, not just the
 * original fixed ids) — so a mid-chain reload can hand this function BOTH
 * a superseded original and its already-created sibling as two separate
 * `prevDesigns` slots. Without de-duping, the original's slot would resolve
 * forward to that same sibling, producing two grid entries with the same
 * id (and the same React `key` in KeywordStudio.tsx) instead of one.
 */
export function mergePolledDesigns<T extends PollableDesign>(
  prevDesigns: readonly T[],
  polledDesigns: readonly T[]
): T[] {
  const claimedIds = new Set<string>();
  const result: T[] = [];

  for (const d of prevDesigns) {
    const updated = polledDesigns.find((nd) => nd.id === d.id);
    if (!updated) {
      result.push(d);
      continue;
    }

    let resolved = updated;
    const seen = new Set<string>([resolved.id]);
    while (resolved.validationStatus === "superseded") {
      const sibling = polledDesigns.find((nd) => nd.regeneratedFromDesignId === resolved.id);
      if (!sibling || seen.has(sibling.id)) break;
      seen.add(sibling.id);
      resolved = sibling;
    }

    if (claimedIds.has(resolved.id)) continue;
    claimedIds.add(resolved.id);

    // Preserve fields the status endpoint doesn't carry (e.g. slug, set
    // once at creation) by spreading onto the existing card rather than
    // replacing it outright — same rationale as the pre-#32 inline merge.
    result.push({ ...d, ...resolved });
  }

  return result;
}
