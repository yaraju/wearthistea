/**
 * System One decision-model spike (issues #39-#41).
 *
 *   npx tsx scripts/spike-system-one.ts --pilot-svg     # Phase 0: Jev feasibility on 24 native-SVG fixtures
 *   npx tsx scripts/spike-system-one.ts --dry --limit 2 # no network; checks fixture/feature plumbing
 *
 * Writes results to spike-results/ (gitignored). Never touches the shared
 * prod DB or GCS: fixtures are synthetic and generated locally.
 */
import dotenv from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
dotenv.config();

const arg = (name: string) => process.argv.includes(name);
const argVal = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

async function pilotSvg() {
  const { buildFixtures } = await import("./spike/fixtures");
  const { extractFeatures } = await import("../src/lib/decision/features");
  const { jevJudge } = await import("../src/lib/decision/jev");
  const { geminiJudge } = await import("../src/lib/decision/gemini");
  const m = await import("./spike/metrics");

  const limit = Number(argVal("--limit") ?? 0);
  let fixtures = await buildFixtures(2);
  if (limit) fixtures = fixtures.slice(0, limit);
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const dry = arg("--dry");
  const skipGemini = arg("--no-gemini") || dry;
  console.log(`Fixtures: ${fixtures.length} (${dry ? "DRY: no network" : "live"})`);

  const arms: Record<string, import("./spike/metrics").ArmRow[]> = { gemini: [], jev_features: [], jev_svg: [] };
  if (dry) {
    for (const f of fixtures.slice(0, 2)) {
      console.log(f.id, JSON.stringify(await extractFeatures(f.imageB64)), `svg=${f.svg.length} chars`);
    }
    return;
  }

  await mapLimit(fixtures, 2, async (f) => {
    const input = { phrase: f.phrase, visualConcept: f.visualConcept, claimedColor: f.claimedColor, style: "raster" as const, imageB64: f.imageB64, svg: f.svg };
    const features = await extractFeatures(f.imageB64);
    const [b1, b3, a] = await Promise.all([
      jevJudge(input, "features", { features }),
      jevJudge(input, "svg"),
      skipGemini ? Promise.resolve(null) : geminiJudge(input),
    ]);
    arms.jev_features.push({ fixtureId: f.id, kind: f.kind, color: f.claimedColor, result: b1 });
    arms.jev_svg.push({ fixtureId: f.id, kind: f.kind, color: f.claimedColor, result: b3 });
    if (a) arms.gemini.push({ fixtureId: f.id, kind: f.kind, color: f.claimedColor, result: a });
  });

  const summary: Record<string, unknown> = {};
  for (const [name, rows] of Object.entries(arms)) {
    if (rows.length === 0) continue;
    const score = m.scoreArm(rows, byId);
    const lat = m.latencyStats(rows.map((r) => r.result.meter.latencyMs).filter(Boolean));
    summary[name] = {
      ...score,
      latencyMs: lat,
      totalCostUsd: m.sum(rows, (x) => x.costUsd),
      inputTokens: m.sum(rows, (x) => x.inputTokens),
      attributeAcc: name.startsWith("jev") ? m.attributeAccuracy(rows, byId) : undefined,
    };
    console.log(`\n== ${name} ==`);
    console.log(JSON.stringify(summary[name], null, 1));
    const errs = rows.filter((r) => r.result.error);
    if (errs.length) console.log("errors:", errs.slice(0, 3).map((e) => e.result.error));
  }

  mkdirSync("spike-results", { recursive: true });
  const file = `spike-results/pilot-svg-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify({ summary, arms, fixtureMeta: fixtures.map(({ id, kind, claimedColor, truth }) => ({ id, kind, claimedColor, truth })) }, null, 1));
  console.log(`\nSaved ${file}`);
}

async function main() {
  if (arg("--pilot-svg")) return pilotSvg();
  if (arg("--style-review")) return (await import("./spike/modes")).runStyleReview(Number(argVal("--repeats") ?? 3));
  if (arg("--gate")) return (await import("./spike/modes")).runGate();
  if (arg("--image-matrix")) return (await import("./spike/modes")).runImageMatrix(Number(argVal("--n") ?? 12), Number(argVal("--offset") ?? 0), argVal("--arms")?.split(","));
  if (arg("--prod-judge")) return (await import("./spike/modes")).runProdJudge(Number(argVal("--n") ?? 60));
  if (arg("--judge-art")) return (await import("./spike/modes")).runJudgeArt();
  if (arg("--gen-art")) {
    const { genArt } = await import("./spike/gen-art");
    const items = await genArt(Number(argVal("--per") ?? 4));
    const ok = items.filter((i) => !i.error);
    console.log(`Generated ${ok.length}/${items.length}; resolved Black=${ok.filter((i) => i.resolved === "Black").length} White=${ok.filter((i) => i.resolved === "White").length}`);
    return;
  }
  console.log("Specify --pilot-svg (more modes land with issues #40/#41).");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
