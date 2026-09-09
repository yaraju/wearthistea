/**
 * Exercises checkGenerateRateLimit's counting logic directly against the DB
 * (via the Cache model) without spending any Gemini budget — confirms an
 * anonymous caller gets blocked once it crosses the live maxAnonymous
 * ceiling, and that a different anonymous id isn't affected. Reads whatever
 * RateLimitConfig is already live rather than changing it — this script must
 * never write RateLimitConfig/RateLimitOverride, since DATABASE_URL here is
 * the same DB real traffic uses and any such write would affect it
 * immediately (the ~15s cache TTL, not a redeploy, is the only thing
 * standing between an admin/script edit and live traffic). Only touches
 * Cache rows scoped to this run's own throwaway anonymous id.
 *
 *   npx tsx scripts/test-rate-limit.ts
 */
import dotenv from "dotenv";
dotenv.config();

import { checkGenerateRateLimit, recordGenerateUsage, getRateLimitSettings } from "../src/lib/rate-limit";
import { ANON_ID_HEADER } from "../src/lib/anon-id";
import { prisma } from "../src/lib/prisma";

function fakeAnonRequest(anonId: string): Request {
  return new Request("http://localhost/api/generate/retry", {
    headers: { [ANON_ID_HEADER]: anonId },
  });
}

async function main() {
  const { config } = await getRateLimitSettings();
  const { maxAnonymous } = config;
  console.log(`maxAnonymous=${maxAnonymous} (live config, unmodified by this script)`);

  const testId = `test-${Date.now()}`;

  let blockedAt = -1;
  for (let i = 1; i <= maxAnonymous + 3; i++) {
    const result = await checkGenerateRateLimit(fakeAnonRequest(testId));
    console.log(`request ${i}: ok=${result.ok}`);
    // Mirrors real callers: check, then only spend budget on success.
    if (result.ok) await recordGenerateUsage(result);
    if (!result.ok && blockedAt === -1) blockedAt = i;
  }

  if (blockedAt !== maxAnonymous + 1) {
    throw new Error(`Expected blocking to start at request ${maxAnonymous + 1}, got ${blockedAt}`);
  }
  console.log(`PASS: anonymous caller blocked starting at request ${blockedAt}`);

  // A different anonymous id should be unaffected.
  const other = await checkGenerateRateLimit(fakeAnonRequest(`test-other-${Date.now()}`));
  if (!other.ok) throw new Error("FAIL: unrelated anonymous id was blocked too");
  console.log("PASS: unrelated anonymous id unaffected");

  // Cleanup the test rows so repeated runs don't accumulate junk.
  await prisma.cache.deleteMany({ where: { key: { contains: testId } } });
}

main()
  .catch((e) => {
    console.error("FAILED:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
