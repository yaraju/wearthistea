import { CloudTasksClient } from "@google-cloud/tasks";
import { sendEmail, type EmailPayload } from "./email";
import { logger } from "./logger";

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
