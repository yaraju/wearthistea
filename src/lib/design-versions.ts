import { prisma } from "./prisma";

/**
 * Version-chain awareness (issue #20) — single source of truth for "walk the
 * regeneration chain" logic, reused by every surface that displays a Design
 * (search/gallery, /design/[slug], admin review) so none of them drift.
 *
 * Built on the lineage columns added in #11 (see prisma/schema.prisma's
 * Design model): `regeneratedFromDesignId` (child -> parent, @unique — at
 * most one regeneration per source design) and the inverse relations
 * `regeneratedFrom` / `regeneratedInto`. Because the FK is @unique, the
 * chain is always a simple linked list (≤1 child, ≤1 parent per node), never
 * a tree — every walk below is a straight-line loop, not a graph traversal.
 *
 * IMPORTANT for order-linked views (order history, order confirmation, admin
 * order views — anything joining through Order.designId): NEVER import this
 * module there. An Order must always render the exact Design row it
 * references, forever, even after that row is superseded. Enforce this by
 * simply not calling resolveLatestDesignVersion()/getDesignVersionChain()
 * from an order-display code path — see the eslint override in
 * eslint.config.mjs, which fails the build if one of those paths imports
 * this module.
 */

/**
 * Minimal shape the walkers below need — any Design row, the full Prisma
 * type or a leaner `select`, as long as it carries these three fields.
 */
export interface VersionChainNode {
  id: string;
  validationStatus: string;
  regeneratedFromDesignId: string | null;
}

/**
 * Looks up the sibling a design (by id) was regenerated INTO — at most one,
 * since regeneratedFromDesignId is @unique — or null if it hasn't been
 * regenerated (yet). Swappable: production code's default reads through
 * Prisma; unit tests inject an in-memory version instead, which is what
 * makes resolveLatestDesignVersion/getDesignVersionChain testable against
 * fixtures rather than the real (shared, production) DB — see
 * scripts/test-version-chain.ts.
 */
export type ChildLookup<T> = (sourceDesignId: string) => Promise<T | null> | T | null;
/** Looks up a design by id — used to walk backward via regeneratedFromDesignId. */
export type ByIdLookup<T> = (id: string) => Promise<T | null> | T | null;

function defaultChildLookup<T extends VersionChainNode>(sourceDesignId: string): Promise<T | null> {
  return prisma.design.findUnique({ where: { regeneratedFromDesignId: sourceDesignId } }) as unknown as Promise<
    T | null
  >;
}

function defaultByIdLookup<T extends VersionChainNode>(id: string): Promise<T | null> {
  return prisma.design.findUnique({ where: { id } }) as unknown as Promise<T | null>;
}

/**
 * Walk regeneratedInto forward to the terminal (non-superseded) sibling.
 * A chain can in principle be more than one hop deep (a regenerated sibling
 * can itself later be superseded) — this loops hop by hop via `findChild`
 * rather than assuming a fixed depth. A single Prisma `include` only reaches
 * one hop, which is why this takes a lookup function and does its own
 * DB round trips (skipped entirely for the common case: a design that was
 * never superseded returns immediately, no queries at all).
 *
 * Guarded against a cycle or a dangling loop with a visited-id set — the
 * DB's @unique constraint on regeneratedFromDesignId rules out a real cycle
 * today, but this never trusts that against bad or future data; it stops
 * and returns the last node reached rather than looping forever.
 *
 * - No supersession: returns `design` itself.
 * - Superseded once: returns its sibling.
 * - Superseded N times (chained): returns the final terminal sibling, never
 *   an intermediate one.
 * - Superseded with no recorded successor (shouldn't happen — a regenerate
 *   always sets regeneratedFromDesignId on the sibling it creates — but
 *   never assumed): returns the last node actually reached, never null.
 */
export async function resolveLatestDesignVersion<T extends VersionChainNode>(
  design: T,
  findChild: ChildLookup<T> = defaultChildLookup
): Promise<T> {
  let current = design;
  const seen = new Set<string>([current.id]);
  while (current.validationStatus === "superseded") {
    const next = await findChild(current.id);
    if (!next || seen.has(next.id)) break;
    seen.add(next.id);
    current = next;
  }
  return current;
}

export interface DesignVersionChainEntry<T extends VersionChainNode> {
  design: T;
  /** True for the terminal/current-best version — the one
   *  resolveLatestDesignVersion() would resolve any node in this chain to. */
  isLatest: boolean;
  /** True for whichever node was originally passed in to this call. */
  isRequested: boolean;
}

/**
 * Walk both directions from `design` — backward via regeneratedFromDesignId,
 * forward via regeneratedInto (repeatedly, however many hops deep the real
 * chain goes) — and return the full lineage in order (oldest first), each
 * entry marked whether it's the latest version and whether it's the one
 * originally requested. For admin display: "the whole picture."
 *
 * Existence-based (follows every recorded regeneratedFromDesignId link,
 * regardless of validationStatus) rather than stopping at the first
 * non-superseded node the way resolveLatestDesignVersion does — admin
 * lineage should never silently drop a row just because a status write
 * raced or was skipped.
 */
export async function getDesignVersionChain<T extends VersionChainNode>(
  design: T,
  lookups: { findChild?: ChildLookup<T>; findById?: ByIdLookup<T> } = {}
): Promise<DesignVersionChainEntry<T>[]> {
  const findChild = lookups.findChild ?? defaultChildLookup;
  const findById = lookups.findById ?? defaultByIdLookup;

  // Walk backward to the root ancestor.
  let root = design;
  const seenBack = new Set<string>([root.id]);
  while (root.regeneratedFromDesignId) {
    const parent = await findById(root.regeneratedFromDesignId);
    if (!parent || seenBack.has(parent.id)) break;
    seenBack.add(parent.id);
    root = parent;
  }

  // Walk forward from the root, collecting the full lineage.
  const chain: T[] = [root];
  const seenFwd = new Set<string>([root.id]);
  let cursor = root;
  for (;;) {
    const next = await findChild(cursor.id);
    if (!next || seenFwd.has(next.id)) break;
    seenFwd.add(next.id);
    chain.push(next);
    cursor = next;
  }

  const latestId = chain[chain.length - 1].id;
  return chain.map((node) => ({
    design: node,
    isLatest: node.id === latestId,
    isRequested: node.id === design.id,
  }));
}
