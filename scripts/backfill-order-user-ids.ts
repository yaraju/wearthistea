/**
 * One-time migration: link guest-checkout Orders to the registered User
 * account that matches their recipientEmail, so they show up under
 * /account/orders. Guest checkouts always write userId: null (see
 * src/app/api/designs/select/route.ts) even when the buyer was, or later
 * became, a signed-in user with a matching email — this backfills that gap
 * for orders that already have an email to match on.
 *
 * Deliberately does NOT touch Design.createdByUserId — the pick-time flow
 * lets a buyer order someone else's brewed design, so attributing the
 * design itself to the order's buyer would misrepresent whose brew it was.
 * This only fixes Order.userId, which is exactly what /api/account/orders
 * filters on.
 *
 * Usage: npx tsx scripts/backfill-order-user-ids.ts
 */
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const { prisma } = await import("../src/lib/prisma");

  const candidates = await prisma.order.findMany({
    where: { userId: null, recipientEmail: { not: null } },
    select: { id: true, recipientEmail: true, status: true, createdAt: true },
  });

  if (candidates.length === 0) {
    console.log("No candidate orders (userId: null, recipientEmail set) found.");
    await prisma.$disconnect();
    return;
  }

  const emailsLower = [...new Set(candidates.map((c) => (c.recipientEmail as string).toLowerCase()))];
  const users = await prisma.user.findMany({
    where: { email: { in: emailsLower } },
    select: { id: true, email: true },
  });
  const userIdByEmailLower = new Map(users.map((u) => [u.email.toLowerCase(), u.id]));

  let updated = 0;
  const updatedOrders: { id: string; email: string; userId: string }[] = [];
  const unmatched: { id: string; email: string }[] = [];

  for (const c of candidates) {
    const email = c.recipientEmail as string;
    const userId = userIdByEmailLower.get(email.toLowerCase());
    if (!userId) {
      unmatched.push({ id: c.id, email });
      continue;
    }
    await prisma.order.update({ where: { id: c.id }, data: { userId } });
    updated++;
    updatedOrders.push({ id: c.id, email, userId });
  }

  console.log(
    JSON.stringify(
      {
        totalCandidates: candidates.length,
        updated,
        unmatchedCount: unmatched.length,
      },
      null,
      2
    )
  );
  console.log("Updated orders:", JSON.stringify(updatedOrders, null, 2));
  console.log("Unmatched (no registered User with this email):", JSON.stringify(unmatched, null, 2));

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("ERROR", e);
  process.exitCode = 1;
});
