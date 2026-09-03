/**
 * Exercise the email templates + enqueueEmail's fallback path without
 * needing SendGrid/Cloud Tasks configured — confirms the plumbing (template
 * rendering, the "not configured yet" fallback, and clean failure when
 * SENDGRID_API_KEY is unset) without actually sending anything.
 *
 *   npx tsx scripts/test-email.ts
 */
import dotenv from "dotenv";
dotenv.config();

import { orderConfirmationEmail, shippedEmail, refundProcessedEmail } from "../src/lib/email";
import { enqueueEmail } from "../src/lib/tasks";

async function main() {
  const confirmation = orderConfirmationEmail({
    recipientName: "Test User",
    designTitle: "Category Is Chaos",
    variantSize: "S",
    variantColor: "Black",
    quantity: 2,
    totalRupees: 1198,
    invoiceNumber: "INV-2026-27-000003",
  });
  console.log("=== orderConfirmationEmail ===");
  console.log("subject:", confirmation.subject);
  console.log(confirmation.text);

  const shipped = shippedEmail({
    recipientName: "Test User",
    designTitle: "Category Is Chaos",
    trackingNumber: "AWB123456789",
  });
  console.log("\n=== shippedEmail ===");
  console.log("subject:", shipped.subject);
  console.log(shipped.text);

  const refund = refundProcessedEmail({
    recipientName: "Test User",
    designTitle: "Category Is Chaos",
    amountRupees: 1198,
    reason: "Out of stock",
  });
  console.log("\n=== refundProcessedEmail ===");
  console.log("subject:", refund.subject);
  console.log(refund.text);

  console.log("\n=== enqueueEmail (no Cloud Tasks configured -> falls back inline) ===");
  try {
    await enqueueEmail({ to: "test@example.com", ...confirmation });
    console.log("Sent (unexpected — SENDGRID_API_KEY shouldn't be set in this test run).");
  } catch (err) {
    console.log("Failed as expected:", err instanceof Error ? err.message : err);
  }
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
