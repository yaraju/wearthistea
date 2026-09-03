/**
 * Exercises checkGenerateRateLimit's counting logic directly against the DB
 * (via the Cache model) without spending any Gemini budget — confirms a
 * session gets blocked once it crosses maxPerSession, and that a different
 * session/IP isn't affected.
 *
 *   npx tsx scripts/test-rate-limit.ts
 */
import dotenv from "dotenv";
dotenv.config();

import { checkGenerateRateLimit, RATE_LIMIT_COOKIE } from "../src/lib/rate-limit";
import { settings } from "../src/config/settings";
import { prisma } from "../src/lib/prisma";

function fakeRequest(sessionId: string | null, ip: string): Request {
  const headers: Record<string, string> = { "x-forwarded-for": ip };
  if (sessionId) headers["cookie"] = `${RATE_LIMIT_COOKIE}=${sessionId}`;
  return new Request("http://localhost/api/generate", { headers });
}

async function main() {
  const testSid = `test-${Date.now()}`;
  const { maxPerSession } = settings.rateLimit;
  console.log(`maxPerSession=${maxPerSession}`);

  let blockedAt = -1;
  for (let i = 1; i <= maxPerSession + 3; i++) {
    const result = await checkGenerateRateLimit(fakeRequest(testSid, "203.0.113.5"));
    console.log(`request ${i}: ok=${result.ok}`);
    if (!result.ok && blockedAt === -1) blockedAt = i;
  }

  if (blockedAt !== maxPerSession + 1) {
    throw new Error(
      `Expected blocking to start at request ${maxPerSession + 1}, got ${blockedAt}`
    );
  }
  console.log(`PASS: session blocked starting at request ${blockedAt}`);

  // A different session on a different IP should be unaffected.
  const other = await checkGenerateRateLimit(fakeRequest(`test-other-${Date.now()}`, "198.51.100.9"));
  if (!other.ok) throw new Error("FAIL: unrelated session was blocked too");
  console.log("PASS: unrelated session/IP unaffected");

  // Cleanup the test rows so repeated runs don't accumulate junk.
  await prisma.cache.deleteMany({ where: { key: { contains: testSid } } });
}

main()
  .catch((e) => {
    console.error("FAILED:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
