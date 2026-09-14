import { CloudTasksClient } from "@google-cloud/tasks";
import { sendEmail, type EmailPayload } from "./email";
import { logger } from "./logger";
import type { RateLimitResult } from "./rate-limit";
import type { JudgeVerdict } from "./design-judge";

let client: CloudTasksClient | null = null;

/** Queue an email to be sent by /api/tasks/send-email instead of awaiting
 * SendGrid inline — mirrors the precedent already set by splitting
 * /api/generate into two stages to work around Firebase Hosting's ~60s
 * proxy timeout: a slow outbound call shouldn't hold open a payment
 * webhook or checkout response.
 *
 * Falls back to sending inline when CLOUD_TASKS_QUEUE_EMAIL isn't configured
 * (e.g. local dev, before `gcloud tasks queues create` has been run) —
 * degraded (synchronous), but still sends, rather than silently dropping
 * the email until the queue exists. Deliberately a separate queue from
 * Printrove product-library creation (CLOUD_TASKS_QUEUE_PRINTROVE) — the two
 * workloads want different retry/concurrency tuning; see deploy.yml. */
export async function enqueueEmail(payload: EmailPayload): Promise<void> {
  const queueName = process.env.CLOUD_TASKS_QUEUE_EMAIL;
  const siteUrl = process.env.SITE_URL;
  const sharedSecret = process.env.TASKS_SHARED_SECRET;

  if (!queueName || !siteUrl || !sharedSecret) {
    logger.info("[tasks] Cloud Tasks not configured — sending email inline", { to: payload.to });
    await sendEmail(payload);
    return;
  }

  const projectId = process.env.GCP_PROJECT_ID || "wearthistea";
  const location = process.env.GCP_REGION || "us-central1";

  if (!client) client = new CloudTasksClient();
  const parent = client.queuePath(projectId, location, queueName);

  await client.createTask({
    parent,
    task: {
      httpRequest: {
        httpMethod: "POST",
        url: `${siteUrl.replace(/\/$/, "")}/api/tasks/send-email`,
        headers: { "Content-Type": "application/json", "X-Task-Secret": sharedSecret },
        body: Buffer.from(JSON.stringify(payload)).toString("base64"),
      },
    },
  });
}

/** Queue Printrove preview-product creation for a freshly-rendered design
 * (uploads the art once, creates one product per enabled category — see
 * design-products.ts). Called right after /api/generate/retry marks a
 * design "generated".
 *
 * Deliberately NO synchronous fallback when CLOUD_TASKS_QUEUE_PRINTROVE
 * isn't configured — unlike enqueueEmail, running this inline (one upload +
 * up to 4 createProduct calls, each a real network round-trip to a
 * third-party API) would reintroduce the same ~60s Firebase Hosting proxy
 * timeout risk that the /api/generate -> /api/generate/retry split exists
 * to avoid. If the queue isn't configured, brewing just skips ahead without
 * pre-built previews — the customer-facing pick-time endpoint calls the
 * same ensureDesignProduct() on demand, so nothing is lost, only delayed. */
export async function enqueuePrintroveProducts(designId: string): Promise<void> {
  const queueName = process.env.CLOUD_TASKS_QUEUE_PRINTROVE;
  const siteUrl = process.env.SITE_URL;
  const sharedSecret = process.env.TASKS_SHARED_SECRET;

  if (!queueName || !siteUrl || !sharedSecret) {
    logger.info("[tasks] Printrove queue not configured — skipping brew-time preview creation", {
      designId,
    });
    return;
  }

  const projectId = process.env.GCP_PROJECT_ID || "wearthistea";
  const location = process.env.GCP_REGION || "us-central1";

  if (!client) client = new CloudTasksClient();
  const parent = client.queuePath(projectId, location, queueName);

  await client.createTask({
    parent,
    task: {
      // Longer than the email task's default — one upload + several
      // sequential createProduct calls to a third-party API can run past
      // Cloud Tasks' 10-minute default dispatch deadline.
      dispatchDeadline: { seconds: 25 * 60 },
      httpRequest: {
        httpMethod: "POST",
        url: `${siteUrl.replace(/\/$/, "")}/api/tasks/printrove-products`,
        headers: { "Content-Type": "application/json", "X-Task-Secret": sharedSecret },
        body: Buffer.from(JSON.stringify({ designId })).toString("base64"),
      },
    },
  });
}

/**
 * Queue a design's actual artwork render — the moment brewing writes a
 * "generating" placeholder row (in /api/generate), instead of relying on the
 * browser to fire /api/generate/retry per design (KeywordStudio.tsx used to
 * do this client-side, which meant closing the tab mid-batch permanently
 * orphaned whatever hadn't fired yet — every design past that point sat at
 * "generating" forever with no error, since nothing server-side ever
 * revisited it). Moving the trigger here means the render happens
 * regardless of whether anyone's still watching; the client just polls
 * /api/generate/status.
 *
 * `rateLimit` carries the caller's resolved identity (tier/bucketKey/
 * windowMs/limit) from the original /api/generate request — the task runs
 * later, often with no Request/cookies at all, so it re-checks this same
 * bucket itself via reevaluateRateLimit() right before spending it (see
 * /api/tasks/render-design), preserving today's exact per-design
 * check-then-spend behavior instead of gating the whole batch atomically.
 *
 * Returns false when the queue isn't configured (e.g. local dev without
 * `gcloud tasks queues create` having been run) so the caller can fall back
 * to rendering inline — unlike enqueuePrintroveProducts, this one DOES need
 * a fallback: skipping it entirely would silently leave every design at
 * "generating" forever with no queue to ever pick it up.
 */
export async function enqueueDesignRender(designId: string, rateLimit: RateLimitResult): Promise<boolean> {
  const queueName = process.env.CLOUD_TASKS_QUEUE_RENDER;
  const siteUrl = process.env.SITE_URL;
  const sharedSecret = process.env.TASKS_SHARED_SECRET;

  if (!queueName || !siteUrl || !sharedSecret) {
    logger.info("[tasks] Render queue not configured — caller should render inline", { designId });
    return false;
  }

  const projectId = process.env.GCP_PROJECT_ID || "wearthistea";
  const location = process.env.GCP_REGION || "us-central1";

  if (!client) client = new CloudTasksClient();
  const parent = client.queuePath(projectId, location, queueName);

  await client.createTask({
    parent,
    task: {
      // A single Gemini image render + mockup composite + back print —
      // generous but well under Cloud Tasks' 10-minute default.
      dispatchDeadline: { seconds: 5 * 60 },
      httpRequest: {
        httpMethod: "POST",
        url: `${siteUrl.replace(/\/$/, "")}/api/tasks/render-design`,
        headers: { "Content-Type": "application/json", "X-Task-Secret": sharedSecret },
        body: Buffer.from(JSON.stringify({ designId, rateLimit })).toString("base64"),
      },
    },
  });
  return true;
}

/**
 * Queue a rendered design's judge pass (issue #13) — src/lib/
 * validation-chain.ts's runJudgeStep(), dispatched by
 * /api/tasks/judge-design. Enqueued right after a fresh render succeeds
 * (see /api/tasks/render-design/route.ts) and again by fix-design/
 * regenerate-design once their own step finishes, closing the
 * judge -> fix/regenerate -> judge loop.
 *
 * Deliberately NO synchronous fallback when CLOUD_TASKS_QUEUE_JUDGE isn't
 * configured (e.g. local dev) — same reasoning as enqueuePrintroveProducts:
 * an unjudged design (validationStatus just stays at its current value,
 * "unjudged" by default) is a valid, harmless settled state from
 * KeywordStudio.tsx's polling perspective (see validation-status.ts's
 * IN_FLIGHT_VALIDATION_STATUSES), not a stuck-forever pathology the way an
 * unrendered design would be. Callers should only advance validationStatus
 * to "pending" when this returns true — see /api/tasks/render-design/route.ts.
 */
export async function enqueueDesignJudge(designId: string): Promise<boolean> {
  const queueName = process.env.CLOUD_TASKS_QUEUE_JUDGE;
  const siteUrl = process.env.SITE_URL;
  const sharedSecret = process.env.TASKS_SHARED_SECRET;

  if (!queueName || !siteUrl || !sharedSecret) {
    logger.info("[tasks] Judge queue not configured — design left unjudged", { designId });
    return false;
  }

  const projectId = process.env.GCP_PROJECT_ID || "wearthistea";
  const location = process.env.GCP_REGION || "us-central1";

  if (!client) client = new CloudTasksClient();
  const parent = client.queuePath(projectId, location, queueName);

  await client.createTask({
    parent,
    task: {
      // One Gemini multimodal judge call + a sharp luminance measurement —
      // comfortably under a couple of minutes even accounting for a slow
      // Gemini response.
      dispatchDeadline: { seconds: 3 * 60 },
      httpRequest: {
        httpMethod: "POST",
        url: `${siteUrl.replace(/\/$/, "")}/api/tasks/judge-design`,
        headers: { "Content-Type": "application/json", "X-Task-Secret": sharedSecret },
        body: Buffer.from(JSON.stringify({ designId })).toString("base64"),
      },
    },
  });
  return true;
}

/**
 * Queue a cheap programmatic fix (relabel / invert-ink / rerun-bg-removal,
 * issue #14) for a design the judge flagged — routed here by judge-design
 * when judgeDesign()'s `fix` field names one of those three and the
 * design's validationFixAttempts budget (cap 2) allows another attempt. See
 * src/lib/design-fix.ts's applyProgrammaticFix() (issue #14) and
 * src/lib/validation-chain.ts's runFixStep(), which calls it. `verdict` is
 * carried through the task body rather than recomputed —
 * judge-design already spent the one Gemini call to get it.
 *
 * No synchronous fallback (same reasoning as enqueueDesignJudge above) —
 * without the queue configured, the design is simply left at
 * "regenerating" with nothing to redrive it, which is a harmless (if
 * permanently in-flight-looking) local-dev-only state.
 */
export async function enqueueDesignFix(designId: string, verdict: JudgeVerdict): Promise<boolean> {
  const queueName = process.env.CLOUD_TASKS_QUEUE_FIX;
  const siteUrl = process.env.SITE_URL;
  const sharedSecret = process.env.TASKS_SHARED_SECRET;

  if (!queueName || !siteUrl || !sharedSecret) {
    logger.info('[tasks] Fix queue not configured — design left at "regenerating" with nothing to redrive it', {
      designId,
    });
    return false;
  }

  const projectId = process.env.GCP_PROJECT_ID || "wearthistea";
  const location = process.env.GCP_REGION || "us-central1";

  if (!client) client = new CloudTasksClient();
  const parent = client.queuePath(projectId, location, queueName);

  await client.createTask({
    parent,
    task: {
      // Cheap pixel-level ops (relabel/invert-ink/rerun-bg-removal), no LLM
      // call — should complete in well under a minute.
      dispatchDeadline: { seconds: 2 * 60 },
      httpRequest: {
        httpMethod: "POST",
        url: `${siteUrl.replace(/\/$/, "")}/api/tasks/fix-design`,
        headers: { "Content-Type": "application/json", "X-Task-Secret": sharedSecret },
        body: Buffer.from(JSON.stringify({ designId, verdict })).toString("base64"),
      },
    },
  });
  return true;
}

/**
 * Queue a full sibling regeneration (issue #15) for a design the judge
 * decided needs one — routed here by judge-design when judgeDesign()'s
 * `fix` field is "regenerate" (or the cheap-fix budget is exhausted and a
 * regen attempt is still available). See src/lib/validation-chain.ts's
 * runRegenerateStep() (creates the sibling + renders it — reuses
 * design-judge-bulk.ts's flagAndTriggerStuckDesign() /
 * /api/admin/designs/[id]/regenerate/route.ts's sibling-creation
 * precedent) and src/lib/design-regenerate.ts's buildRegenerationConcept()
 * (issue #15's stub — today a verbatim passthrough of the source's concept
 * text).
 *
 * No synchronous fallback — same reasoning as enqueueDesignFix above.
 */
export async function enqueueDesignRegenerate(designId: string, verdict: JudgeVerdict): Promise<boolean> {
  const queueName = process.env.CLOUD_TASKS_QUEUE_REGENERATE;
  const siteUrl = process.env.SITE_URL;
  const sharedSecret = process.env.TASKS_SHARED_SECRET;

  if (!queueName || !siteUrl || !sharedSecret) {
    logger.info('[tasks] Regenerate queue not configured — design left at "regenerating" with nothing to redrive it', {
      designId,
    });
    return false;
  }

  const projectId = process.env.GCP_PROJECT_ID || "wearthistea";
  const location = process.env.GCP_REGION || "us-central1";

  if (!client) client = new CloudTasksClient();
  const parent = client.queuePath(projectId, location, queueName);

  await client.createTask({
    parent,
    task: {
      // Same budget as design-render: a full Gemini image render + mockup
      // composite + back print for the new sibling.
      dispatchDeadline: { seconds: 5 * 60 },
      httpRequest: {
        httpMethod: "POST",
        url: `${siteUrl.replace(/\/$/, "")}/api/tasks/regenerate-design`,
        headers: { "Content-Type": "application/json", "X-Task-Secret": sharedSecret },
        body: Buffer.from(JSON.stringify({ designId, verdict })).toString("base64"),
      },
    },
  });
  return true;
}
