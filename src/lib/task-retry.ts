/**
 * Cloud Tasks delivery-attempt helpers (issue #33). A handler that answers
 * 5xx to get a retry must know when it is the LAST delivery the queue will
 * make — otherwise, once the queue's retry budget runs out, whatever row the
 * task was working is left silently stranded in a non-terminal status.
 *
 * QUEUE_MAX_ATTEMPTS mirrors the `--max-attempts` values in
 * .github/workflows/deploy.yml's "Ensure Cloud Tasks queues" step — keep the
 * two in sync. (The queue's max-retry-duration can also end retries early;
 * src/lib/validation-sweeper.ts is the backstop for that.)
 */
export const QUEUE_MAX_ATTEMPTS = {
  render: 4,
  judge: 4,
  fix: 5,
  regenerate: 4,
} as const;

/** True when this delivery is the queue's final attempt. Cloud Tasks sets
 * X-CloudTasks-TaskRetryCount (0 on the first attempt). Absent header (a
 * manual call, local dev) is never treated as final. */
export function isFinalDelivery(req: Request, maxAttempts: number): boolean {
  const raw = req.headers.get("x-cloudtasks-taskretrycount");
  if (raw == null) return false;
  const retryCount = Number.parseInt(raw, 10);
  return Number.isFinite(retryCount) && retryCount >= maxAttempts - 1;
}
