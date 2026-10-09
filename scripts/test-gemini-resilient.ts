/**
 * Unit test for withModelFallback (src/lib/gemini-resilient.ts): simulated
 * 503/429/402 errors, no network. Usage: npx tsx scripts/test-gemini-resilient.ts
 */
export {};
let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  [${ok ? "ok" : "FAIL"}] ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures++;
}
const err = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

async function main() {
  const { withModelFallback } = await import("../src/lib/gemini-resilient");
  const sleep = async () => {};

  // 1. success first try
  let calls: string[] = [];
  let r = await withModelFallback("A", async (m) => (calls.push(m), "ok"), { backupModel: "B", sleep });
  check("first-try success uses primary only", calls.join() === "A" && r.failedAttempts === 0 && r.servedBy === "A");

  // 2. one 503 then success on primary retry
  calls = [];
  r = await withModelFallback("A", async (m) => { calls.push(m); if (calls.length === 1) throw err(503); return "ok"; }, { backupModel: "B", sleep });
  check("503 then retry on primary", calls.join() === "A,A" && r.servedBy === "A" && r.failedAttempts === 1);

  // 3. two 503s then backup
  calls = [];
  r = await withModelFallback("A", async (m) => { calls.push(m); if (m === "A") throw err(503); return "ok"; }, { backupModel: "B", sleep });
  check("two 503s fall back to backup", calls.join() === "A,A,B" && r.servedBy === "B" && r.failedAttempts === 2);

  // 4. 429 treated as transient
  calls = [];
  r = await withModelFallback("A", async (m) => { calls.push(m); if (m === "A") throw err(429); return "ok"; }, { backupModel: "B", sleep });
  check("429 falls back", r.servedBy === "B");

  // 5. no backup configured: rethrows after retry
  calls = [];
  let threw = false;
  try { await withModelFallback("A", async (m) => { calls.push(m); throw err(503); }, { sleep }); } catch (e) { threw = (e as { status?: number }).status === 503; }
  check("no backup: retries once then rethrows 503", threw && calls.join() === "A,A");

  // 6. 402 (billing) is not retried and not failed over
  calls = [];
  threw = false;
  try { await withModelFallback("A", async (m) => { calls.push(m); throw err(402); }, { backupModel: "B", sleep }); } catch (e) { threw = (e as { status?: number }).status === 402; }
  check("402 rethrown immediately, no retry/backup", threw && calls.join() === "A");

  // 7. 400 not retried
  calls = [];
  threw = false;
  try { await withModelFallback("A", async (m) => { calls.push(m); throw err(400); }, { backupModel: "B", sleep }); } catch { threw = true; }
  check("400 not retried", threw && calls.join() === "A");

  // 8. backup equal to primary is ignored
  calls = [];
  threw = false;
  try { await withModelFallback("A", async (m) => { calls.push(m); throw err(503); }, { backupModel: "A", sleep }); } catch { threw = true; }
  check("backup == primary ignored", threw && calls.join() === "A,A");

  // 9. backup also fails -> error surfaces
  calls = [];
  threw = false;
  try { await withModelFallback("A", async (m) => { calls.push(m); throw err(503); }, { backupModel: "B", sleep }); } catch (e) { threw = (e as { status?: number }).status === 503; }
  check("all attempts fail -> last error thrown", threw && calls.join() === "A,A,B");

  console.log(failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`);
  if (failures) process.exitCode = 1;
}
main();
