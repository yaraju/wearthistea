/**
 * Model-fallback wrapper for Gemini calls. Provider 503 ("high demand") and
 * 429 (quota) errors were previously thrown straight to the caller (Cloud
 * Tasks redelivery was the only retry). Policy: on a transient error retry
 * the primary model once after a short jittered pause, then try the backup
 * model (if configured and different). Non-transient errors — including 402
 * "prepayment credits depleted", which a different model on the same billing
 * account would hit too — are rethrown immediately.
 */
import { logger } from "./logger";

export const TRANSIENT_STATUSES = [429, 500, 503, 504];

export function isTransientStatus(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  return status !== undefined && TRANSIENT_STATUSES.includes(status);
}

export interface FallbackOptions {
  /** Backup model, used only after the primary has failed twice transiently. */
  backupModel?: string;
  /** Pause before the single primary retry. Default 1000-2000 ms jittered. */
  retryDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Label for log lines, e.g. "generateImage". */
  label?: string;
}

export interface FallbackResult<T> {
  value: T;
  servedBy: string;
  /** Number of failed attempts before success (0 = first try worked). */
  failedAttempts: number;
}

export async function withModelFallback<T>(
  primaryModel: string,
  run: (model: string) => Promise<T>,
  opts: FallbackOptions = {}
): Promise<FallbackResult<T>> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const backup = opts.backupModel && opts.backupModel !== primaryModel ? opts.backupModel : undefined;
  const plan = backup ? [primaryModel, primaryModel, backup] : [primaryModel, primaryModel];
  let failedAttempts = 0;
  let lastErr: unknown;
  for (let i = 0; i < plan.length; i++) {
    try {
      const value = await run(plan[i]);
      if (failedAttempts > 0) {
        logger.warn(`[${opts.label ?? "gemini"}] recovered after ${failedAttempts} transient failure(s)`, {
          primaryModel,
          servedBy: plan[i],
          fellBack: plan[i] !== primaryModel,
        });
      }
      return { value, servedBy: plan[i], failedAttempts };
    } catch (err) {
      lastErr = err;
      failedAttempts++;
      if (!isTransientStatus(err)) throw err;
      if (i === 0) {
        const base = opts.retryDelayMs ?? 1500;
        await sleep(base * (0.67 + Math.random() * 0.67));
      }
    }
  }
  throw lastErr;
}
