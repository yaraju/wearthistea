/**
 * Stuck-row watchdog for the judge -> fix -> regenerate chain (issue #33).
 *
 * Every step of the chain (src/lib/validation-chain.ts) now ends a row
 * terminally or re-queues it, but Cloud Tasks can still give up (retry
 * duration exhausted, instance killed mid-task, a queue misconfigured) with
 * a row parked in "pending" | "validating" | "regenerating" and nothing left
 * to move it. Nothing else sweeps validationStatus — design-judge-bulk.ts's
 * STUCK_GENERATION_THRESHOLD_MINUTES only covers Design.status "generating"
 * — so a stranded row would keep the UI's "Polishing a couple of details…"
 * badge up forever.
 *
 * Policy per stuck row (updatedAt older than the threshold — every chain
 * step writes the row, so age since updatedAt is age since last progress):
 *   - art never rendered (status !== "generated"): nothing to judge ->
 *     "rejected".
 *   - first time swept: RETRY ONCE — CAS the row to "pending", stamp
 *     SWEEPER_RETRY_MARKER into validationNotes and re-enqueue judge (a
 *     fresh verdict; fix/regen attempt counters are untouched, so the
 *     budget caps still bound the chain).
 *   - already carries the marker (the retry itself stalled), or judge can't
 *     be enqueued: "rejected" with a validationNotes reason.
 * Every write is a compare-and-swap on the status the row was read at, so a
 * task that finishes concurrently wins and the sweeper leaves it alone.
 *
 * Kept side-effect-injectable (store + enqueue) like validation-chain.ts so
 * scripts/test-validation-chain.ts exercises it against an in-memory store.
 * Triggered by Cloud Scheduler -> POST /api/tasks/sweep-stuck-validation
 * (see deploy.yml / GCP_SETUP.md).
 */
import type { Design } from "@prisma/client";
import { prismaDesignStore, type DesignStore } from "./validation-chain";
import { logger } from "./logger";

/** Longer than the slowest legitimate chain step: the queues' retry windows
 * are 30-60 minutes but a step that is genuinely still retrying rewrites the
 * row at least every dispatch; 30 minutes matches
 * design-judge-bulk.ts's STUCK_GENERATION_THRESHOLD_MINUTES. */
export const STUCK_VALIDATION_THRESHOLD_MINUTES = 30;
export const SWEEPER_RETRY_MARKER = "[sweeper:retried]";
export const SWEEP_BATCH_LIMIT = 50;

const IN_FLIGHT = ["pending", "validating", "regenerating"] as const;

export interface SweeperStore extends DesignStore {
  /** Rows in an in-flight validationStatus last written before `cutoff`. */
  findStuck(cutoff: Date, limit: number): Promise<Design[]>;
}

export const prismaSweeperStore: SweeperStore = {
  ...prismaDesignStore,
  async findStuck(cutoff, limit) {
    const { prisma } = await import("./prisma");
    return prisma.design.findMany({
      where: { validationStatus: { in: [...IN_FLIGHT] }, updatedAt: { lt: cutoff } },
      orderBy: { updatedAt: "asc" },
      take: limit,
    });
  },
};

export interface SweepResult {
  scanned: number;
  retried: string[];
  rejected: string[];
  skipped: string[];
}

export interface SweepDeps {
  store?: SweeperStore;
  now?: Date;
  thresholdMinutes?: number;
  enqueueJudge?: (designId: string) => Promise<boolean>;
}

export async function sweepStuckValidations(deps: SweepDeps = {}): Promise<SweepResult> {
  const store = deps.store ?? prismaSweeperStore;
  const now = deps.now ?? new Date();
  const thresholdMinutes = deps.thresholdMinutes ?? STUCK_VALIDATION_THRESHOLD_MINUTES;
  const enqueueJudge = deps.enqueueJudge ?? (async (id: string) => (await import("./tasks")).enqueueDesignJudge(id));

  const cutoff = new Date(now.getTime() - thresholdMinutes * 60_000);
  const stuck = await store.findStuck(cutoff, SWEEP_BATCH_LIMIT);
  const result: SweepResult = { scanned: stuck.length, retried: [], rejected: [], skipped: [] };

  for (const row of stuck) {
    const from = row.validationStatus;
    const age = `${Math.round((now.getTime() - row.updatedAt.getTime()) / 60_000)}min`;
    const reject = async (reason: string) => {
      const done = await store.claim(row.id, [from], {
        validationStatus: "rejected",
        validationNotes: `[sweeper] ${reason} (stuck in "${from}" for ${age})`.slice(0, 4000),
      });
      (done ? result.rejected : result.skipped).push(row.id);
      if (done) logger.error(`[validation-sweeper] Rejected stuck design ${row.id}: ${reason}`, { designId: row.id });
    };

    if (row.status !== "generated") {
      await reject(`artwork never rendered (status "${row.status}")`);
      continue;
    }
    if ((row.validationNotes ?? "").startsWith(SWEEPER_RETRY_MARKER)) {
      await reject("still stuck after one sweeper retry");
      continue;
    }

    const claimed = await store.claim(row.id, [from], {
      validationStatus: "pending",
      validationNotes: `${SWEEPER_RETRY_MARKER} re-judging after being stuck in "${from}" for ${age}`,
    });
    if (!claimed) {
      result.skipped.push(row.id);
      continue;
    }
    let queued = false;
    try {
      queued = await enqueueJudge(row.id);
    } catch (err) {
      logger.error(`[validation-sweeper] Failed to enqueue judge for ${row.id}`, { designId: row.id, error: err });
    }
    if (queued) {
      result.retried.push(row.id);
    } else {
      // Claimed to "pending" but nothing will ever judge it — end it now.
      await store.claim(row.id, ["pending"], {
        validationStatus: "rejected",
        validationNotes: `[sweeper] could not re-enqueue judge (stuck in "${from}" for ${age})`,
      });
      result.rejected.push(row.id);
    }
  }

  if (stuck.length > 0) {
    logger.info(
      `[validation-sweeper] scanned=${result.scanned} retried=${result.retried.length} rejected=${result.rejected.length} skipped=${result.skipped.length}`
    );
  }
  return result;
}
