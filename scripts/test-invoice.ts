/**
 * Generate a sample GST invoice for an existing order, without needing
 * Razorpay/payment wired up. Useful to sanity-check the GST math and PDF
 * layout, or to spot-check a specific order.
 *
 *   npx tsx scripts/test-invoice.ts <orderId>
 */
import dotenv from "dotenv";
dotenv.config();

import { prisma } from "../src/lib/prisma";
import { generateInvoice } from "../src/lib/invoice";

async function main() {
  const orderId = process.argv[2];
  if (!orderId) {
    console.error("Usage: npx tsx scripts/test-invoice.ts <orderId>");
    process.exit(1);
  }

  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) {
    console.error(`Order ${orderId} not found.`);
    process.exit(1);
  }
  console.log(`Order: ${order.id} | category=${order.productCategory} | state=${order.state} | unitPriceCents=${order.unitPriceCents}`);

  const result = await generateInvoice(orderId);
  console.log("Invoice generated:", result);

  const updated = await prisma.order.findUnique({ where: { id: orderId } });
  console.log(`gstRateBps=${updated?.gstRateBps} gstAmountCents=${updated?.gstAmountCents}`);
}

main()
  .catch((e) => {
    console.error("FAILED:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
