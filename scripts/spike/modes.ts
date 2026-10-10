/**
 * Spike run modes beyond the Phase-0 SVG pilot: style-alignment review
 * (text-only) and real-art judging (Black + White flows). Imports of src/
 * modules are dynamic so dotenv has loaded first (repo convention).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { ArmRow } from "./metrics";
import type { ArtItem } from "./gen-art";

export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
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

const save = (name: string, data: unknown) => {
  mkdirSync("spike-results", { recursive: true });
  const file = `spike-results/${name}-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify(data, null, 1));
  console.log(`Saved ${file}`);
};

/** Style-alignment: Gemini 3.7 Flash vs Jev on the labeled concept set, `repeats` passes for latency stats. */
export async function runStyleReview(repeats = 3) {
  const { STYLE_CASES } = await import("./style-set");
  const { geminiStyleReview } = await import("../../src/lib/decision/gemini");
  const { jevStyleReview } = await import("../../src/lib/decision/jev");
  const { BRAND_VOICE, CONCEPT_RULES, ART_RULES } = await import("../../src/config/prompts");
  const { latencyStats } = await import("./metrics");

  const rules = [
    BRAND_VOICE,
    CONCEPT_RULES,
    ART_RULES,
    "NOTE: ART_RULES governs rendered pixels. Only flag visualConcept against ART_RULES if it explicitly INSTRUCTS drawing a prohibited element (logo, copyrighted character, meme screenshot, signature/watermark); merely describing a genre or aesthetic is fine. A missing backPhrase is not a violation.",
  ].join("\n\n");

  type Row = { id: string; rep: number; truth: boolean; gemini: boolean | null; jev: boolean | null; jevP: number | null };
  const rows: Row[] = [];
  const meters: Record<string, { latencyMs: number; costUsd: number; inputTokens: number; retries?: number }[]> = { gemini: [], jev: [] };
  for (let rep = 0; rep < repeats; rep++) {
    await mapLimit(STYLE_CASES, 3, async (c) => {
      const input = { phrase: c.phrase, visualConcept: c.visualConcept, backPhrase: c.backPhrase };
      const [g, j] = await Promise.all([geminiStyleReview(input), jevStyleReview(input, rules)]);
      meters.gemini.push(g.meter);
      meters.jev.push(j.meter);
      rows.push({
        id: c.id,
        rep,
        truth: c.aligned,
        gemini: g.value?.aligned ?? null,
        jev: j.value?.aligned ?? null,
        jevP: j.value?.signals?.violates_rules ?? null,
      });
    });
  }

  const acc = (k: "gemini" | "jev") => {
    const r = rows.filter((x) => x[k] !== null);
    const ok = r.filter((x) => x[k] === x.truth).length;
    const bad = r.filter((x) => !x.truth);
    const caught = bad.filter((x) => x[k] === false).length;
    const good = r.filter((x) => x.truth);
    return {
      n: r.length,
      errors: rows.length - r.length,
      accuracy: ok / r.length,
      violationCatchRate: caught / bad.length,
      falseFlagRate: good.filter((x) => x[k] === false).length / good.length,
    };
  };
  const summary = {
    gemini: { ...acc("gemini"), latencyMs: latencyStats(meters.gemini.map((m) => m.latencyMs).filter(Boolean)), costUsd: meters.gemini.reduce((a, m) => a + (m.costUsd || 0), 0), retries: meters.gemini.reduce((a, m) => a + (m.retries ?? 0), 0) },
    jev: { ...acc("jev"), latencyMs: latencyStats(meters.jev.map((m) => m.latencyMs).filter(Boolean)), costUsd: meters.jev.reduce((a, m) => a + (m.costUsd || 0), 0) },
  };
  console.log(JSON.stringify(summary, null, 1));
  save("style-review", { summary, rows, meters });
}

/** Real generated art: Black + White flows, each judged under its true and a flipped claimed color. */
export async function runJudgeArt(conc = 3) {
  const { extractFeatures } = await import("../../src/lib/decision/features");
  const { jevJudge } = await import("../../src/lib/decision/jev");
  const { geminiJudge, geminiCaption } = await import("../../src/lib/decision/gemini");
  const { vectorizeForJev } = await import("./vectorize");

  const manifest: ArtItem[] = JSON.parse(readFileSync("spike-results/art/manifest.json", "utf8")).filter((i: ArtItem) => !i.error);
  type Claim = { item: ArtItem; claimed: "Black" | "White"; flipped: boolean };
  const claims: Claim[] = manifest.flatMap((item) => [
    { item, claimed: item.resolved, flipped: false },
    { item, claimed: (item.resolved === "Black" ? "White" : "Black") as "Black" | "White", flipped: true },
  ]);
  console.log(`Art items: ${manifest.length}; judgments per arm: ${claims.length}`);

  // Per-art preprocessing is shared across the two claims (vectorize/caption/features are claim-independent) — but each
  // arm is charged its own prep latency/cost per judgment so per-decision numbers are not flattered.
  const prep = new Map<string, Promise<{ features: Awaited<ReturnType<typeof extractFeatures>>; svg: Awaited<ReturnType<typeof vectorizeForJev>>; cap: Awaited<ReturnType<typeof geminiCaption>>; b64: string }>>();
  const getPrep = (item: ArtItem) => {
    if (!prep.has(item.id)) {
      prep.set(
        item.id,
        (async () => {
          const b64 = readFileSync(item.file).toString("base64");
          const [features, svg, cap] = await Promise.all([extractFeatures(b64), vectorizeForJev(b64), geminiCaption(b64)]);
          return { features, svg, cap, b64 };
        })()
      );
    }
    return prep.get(item.id)!;
  };

  const rows: Record<string, (ArmRow & { claimed: string; flipped: boolean; truthColor: boolean; features: unknown; svgChars: number; caption: string })[]> = {
    gemini: [], jev_features: [], jev_caption: [], jev_svg_vec: [],
  };
  await mapLimit(claims, conc, async ({ item, claimed, flipped }) => {
    const p = await getPrep(item);
    const input = { phrase: item.phrase, visualConcept: item.visualConcept, claimedColor: claimed, style: "raster" as const, imageB64: p.b64, svg: p.svg.svg };
    const truthColor = (p.features.inkLuminance !== null && p.features.inkLuminance > 127.5) === (claimed === "Black");
    const [a, b1, b2, b3] = await Promise.all([
      geminiJudge(input),
      jevJudge(input, "features", { features: p.features }),
      jevJudge(input, "caption", { features: p.features, caption: p.cap.caption, prepLatencyMs: p.cap.latencyMs, prepCostUsd: p.cap.costUsd }),
      jevJudge(input, "svg", { prepLatencyMs: p.svg.ms, prepCostUsd: 0 }),
    ]);
    const base = { fixtureId: `${item.id}${flipped ? "-flip" : ""}`, kind: flipped ? "flipped" : "true", color: claimed, claimed, flipped, truthColor, features: p.features, svgChars: p.svg.chars, caption: p.cap.caption };
    rows.gemini.push({ ...base, result: a });
    rows.jev_features.push({ ...base, result: b1 });
    rows.jev_caption.push({ ...base, result: b2 });
    rows.jev_svg_vec.push({ ...base, result: b3 });
  });

  const { latencyStats, kappa } = await import("./metrics");
  const gem = new Map(rows.gemini.map((r) => [r.fixtureId, r]));
  const summary: Record<string, unknown> = {};
  for (const [arm, rs] of Object.entries(rows)) {
    const ok = rs.filter((r) => r.result.value);
    const total = (r: (typeof rs)[number]) => r.result.meter.latencyMs + (r.result.meter.prepLatencyMs ?? 0);
    const pairs = ok.filter((r) => gem.get(r.fixtureId)?.result.value);
    summary[arm] = {
      n: ok.length,
      errors: rs.length - ok.length,
      colorAccVsPixels: ok.filter((r) => r.result.value!.colorMatchesArt === r.truthColor).length / ok.length,
      usableRate: ok.filter((r) => r.result.value!.usable).length / ok.length,
      kappaUsableVsGemini: kappa(pairs.map((r) => r.result.value!.usable), pairs.map((r) => gem.get(r.fixtureId)!.result.value!.usable)),
      latencyMsCallOnly: latencyStats(rs.map((r) => r.result.meter.latencyMs).filter(Boolean)),
      latencyMsWithPrep: latencyStats(rs.map(total).filter(Boolean)),
      costUsdTotal: rs.reduce((s, r) => s + (r.result.meter.costUsd || 0) + (r.result.meter.prepCostUsd ?? 0), 0),
      retries: rs.reduce((s, r) => s + (r.result.meter.retries ?? 0), 0),
    };
  }
  console.log(JSON.stringify(summary, null, 1));
  save("judge-art", { summary, rows });
}

/**
 * READ-ONLY: judge a random sample of real production designs (images from
 * GCS via the app's own loader) with two text/judge models side by side.
 * Run with GCS_BUCKET on the command line (see AGENTS memory: never in .env).
 * Gives the real first-pass pass rate + defect mix on prod art, and a
 * 3.7-flash vs 3.8-flash comparison on identical images.
 */
export async function runProdJudge(n = 60, models = ["gemini-3.7-flash", "gemini-3.8-flash"]) {
  if (!process.env.GCS_BUCKET) throw new Error("Pass GCS_BUCKET on the command line (not .env) or images read from local disk.");
  const { prisma } = await import("../../src/lib/prisma");
  const { loadDesignImageBase64 } = await import("../../src/lib/validation-chain");
  const { geminiJudge } = await import("../../src/lib/decision/gemini");
  const { extractFeatures } = await import("../../src/lib/decision/features");
  const { latencyStats } = await import("./metrics");

  const all = await prisma.design.findMany({
    where: { status: "generated", variantColor: { in: ["Black", "White"] }, designImagePath: { not: "" } },
    select: { id: true, phrase: true, visualConcept: true, style: true, variantColor: true, designImagePath: true, designImageData: true, validationStatus: true, createdAt: true },
  });
  const pick = all.sort(() => Math.random() - 0.5).slice(0, n);
  console.log(`eligible=${all.length} sampled=${pick.length} models=${models.join(", ")}`);
  mkdirSync("spike-results/prod-art", { recursive: true });

  const rows = await mapLimit(pick, 3, async (d) => {
    let b64: string;
    try {
      b64 = await loadDesignImageBase64(d);
    } catch (e) {
      return { id: d.id, error: String(e).slice(0, 120) };
    }
    writeFileSync(`spike-results/prod-art/${d.id}.png`, Buffer.from(b64, "base64"));
    const input = { phrase: d.phrase, visualConcept: d.visualConcept, claimedColor: d.variantColor as "Black" | "White", style: (d.style === "svg" ? "svg" : "raster") as "raster" | "svg", imageB64: b64 };
    const [features, ...res] = await Promise.all([extractFeatures(b64), ...models.map((m) => geminiJudge(input, m))]);
    return { id: d.id, style: d.style, color: d.variantColor, storedValidation: d.validationStatus, createdAt: d.createdAt, features, results: Object.fromEntries(models.map((m, i) => [m, res[i]])) };
  });

  const ok = rows.filter((r) => "results" in r) as Exclude<(typeof rows)[number], { error: string }>[];
  const summary: Record<string, unknown> = { loaded: ok.length, loadErrors: rows.length - ok.length };
  for (const m of models) {
    const rs = ok.map((r) => r.results[m]).filter((x) => x.value);
    const cats: Record<string, number> = {};
    for (const r of rs) {
      const seen = new Set<string>();
      for (const i of r.value!.issues) {
        seen.add(/checker|transparen|background|artifact/i.test(i) ? "background/checkerboard" : /garment|t-?shirt|collar|sleeve|mockup/i.test(i) ? "garment-in-art" : /extra|unrequested|unauthori[sz]ed|additional|readable text/i.test(i) ? "extra-text" : /spell|legib|phrase|misspell|text/i.test(i) ? "phrase/text" : /crop/i.test(i) ? "cropped" : /contrast|detail|blurry|print|outline|sticker/i.test(i) ? "print-quality" : /ink|color/i.test(i) ? "ink/color" : "other");
      }
      for (const k of seen) cats[k] = (cats[k] ?? 0) + 1;
    }
    summary[m] = {
      judged: rs.length,
      errors: ok.length - rs.length,
      firstPassUsableRate: rs.filter((r) => r.value!.usable && r.value!.colorMatchesArt).length / rs.length,
      usableRate: rs.filter((r) => r.value!.usable).length / rs.length,
      defectMix: cats,
      latencyMs: latencyStats(rs.map((r) => r.meter.latencyMs).filter(Boolean)),
      retries: rs.reduce((s, r) => s + (r.meter.retries ?? 0), 0),
      costUsdTotal: rs.reduce((s, r) => s + (r.meter.costUsd || 0), 0),
      outputTokensMean: rs.reduce((s, r) => s + r.meter.outputTokens, 0) / rs.length,
    };
  }
  const both = ok.filter((r) => models.every((m) => r.results[m].value));
  if (models.length === 2 && both.length) {
    const { kappa } = await import("./metrics");
    summary.agreementUsable = both.filter((r) => r.results[models[0]].value!.usable === r.results[models[1]].value!.usable).length / both.length;
    summary.kappaUsable = kappa(both.map((r) => r.results[models[0]].value!.usable), both.map((r) => r.results[models[1]].value!.usable));
  }
  console.log(JSON.stringify(summary, null, 1));
  save("prod-judge", { summary, rows });
  await prisma.$disconnect();
}

/** X0: image-model matrix (cost, latency, 503 rates, first-pass yield) on identical concepts. */
export async function runImageMatrix(nConcepts = 12, offset = 0, only?: string[]) {
  const { renderWithModel, loadConcepts } = await import("./image-matrix");
  const { geminiJudge } = await import("../../src/lib/decision/gemini");
  const { latencyStats } = await import("./metrics");
  const concepts = loadConcepts(nConcepts, offset);
  const allArms: { label: string; model: string; backup: string | null; variant?: "control" | "key" | "svg" }[] = [
    { label: "pro(current)", model: "gemini-3-pro-image", backup: null },
    { label: "nano-banana-2.1(+lite backup)", model: "gemini-nano-banana-2.1", backup: "gemini-3.1-flash-lite-image" },
    { label: "lite", model: "gemini-3.1-flash-lite-image", backup: null },
    { label: "nb2.1+KEY(green bg)", model: "gemini-nano-banana-2.1", backup: "gemini-3.1-flash-lite-image", variant: "key" as const },
    { label: "nb2.1+SVGstyle", model: "gemini-nano-banana-2.1", backup: "gemini-3.1-flash-lite-image", variant: "svg" as const },
  ];
  const arms = only ? allArms.filter((a) => only.some((o) => a.label.startsWith(o))) : allArms;
  console.log(`concepts=${concepts.length} arms=${arms.map((a) => a.label).join(", ")}`);
  type Row = { arm: string; render: Awaited<ReturnType<typeof renderWithModel>>; verdict?: Awaited<ReturnType<typeof geminiJudge>> };
  const rows: Row[] = [];
  await mapLimit(concepts, 2, async (c) => {
    await Promise.all(
      arms.map(async (a) => {
        const render = await renderWithModel(c, a.model, a.backup, `spike-results/img-matrix/${a.model}${a.variant ? `-${a.variant}` : ""}`, a.variant);
        let verdict;
        if (render.file) {
          const b64 = readFileSync(render.file).toString("base64");
          verdict = await geminiJudge({ phrase: c.phrase, visualConcept: c.visualConcept, claimedColor: render.resolved ?? "Black", style: a.variant === "svg" ? "svg" : "raster", imageB64: b64 });
        }
        rows.push({ arm: a.label, render, verdict });
      })
    );
  });
  const cat = (i: string) => (/silhouette|mockup|drawn into|collar|sleeve/i.test(i) && !/garment color|claimed garment/i.test(i) ? "garment-in-art" : /checker|transparen|opaque|background/i.test(i) ? "background" : /extra|unrequested|unauthori|additional text|readable text/i.test(i) ? "extra-text" : /ink|color|contrast|luminance/i.test(i) ? "ink/color" : /spell|legib|phrase|misspell|text/i.test(i) ? "phrase/text" : "other");
  const summary: Record<string, unknown> = {};
  for (const a of arms) {
    const rs = rows.filter((r) => r.arm === a.label);
    const okR = rs.filter((r) => r.render.file);
    const attempts = rs.flatMap((r) => r.render.attempts);
    const first = rs.map((r) => r.render.attempts[0]).filter(Boolean);
    const judged = okR.filter((r) => r.verdict?.value);
    const structural = judged.filter((r) => r.verdict!.value!.issues.some((i) => ["garment-in-art", "background", "extra-text", "phrase/text"].includes(cat(i))));
    const usable = judged.filter((r) => r.verdict!.value!.usable && r.verdict!.value!.colorMatchesArt);
    const cats: Record<string, number> = {};
    for (const r of judged) new Set(r.verdict!.value!.issues.map(cat)).forEach((k) => (cats[k] = (cats[k] ?? 0) + 1));
    const cost = okR.reduce((s, r) => s + (r.render.costUsd ?? 0), 0);
    summary[a.label] = {
      concepts: rs.length,
      rendered: okR.length,
      firstAttemptFailRate: first.filter((x) => !x.ok).length / (first.length || 1),
      firstAttemptStatuses: first.filter((x) => !x.ok).map((x) => x.status ?? "err"),
      totalAttempts: attempts.length,
      fellBack: rs.filter((r) => r.render.fellBack).length,
      finalFailures: rs.length - okR.length,
      wallMs: latencyStats(okR.map((r) => r.render.wallMs)),
      meanCostPerImageUsd: cost / (okR.length || 1),
      dims: [...new Set(okR.map((r) => `${r.render.width}x${r.render.height}`))],
      judgedN: judged.length,
      structuralDefectRate: structural.length / (judged.length || 1),
      firstPassCleanRate: usable.length / (judged.length || 1),
      defectCategories: cats,
      costPerAcceptedUsd: usable.length ? cost / usable.length : null,
      errors: rs.filter((r) => r.render.error).map((r) => r.render.error),
    };
  }
  console.log(JSON.stringify(summary, null, 1));
  save("image-matrix", { summary, rows });
}

/** X2: keyword gate. Jev (7 typed noul questions, one call) vs Gemini flash-lite JSON on the labeled set. */
export async function runGate() {
  const { GATE_CASES } = await import("./gate-set");
  const { screenKeyword, decideFromSignals, KEYWORD_QUESTIONS } = await import("../../src/lib/decision/gate");
  const { ai, isTransientProviderError } = await import("../../src/lib/gemini");
  const { tokenCost } = await import("../../src/lib/decision/pricing");
  const { latencyStats } = await import("./metrics");
  const model = "gemini-3.5-flash-lite";
  const questionsText = Object.entries(KEYWORD_QUESTIONS).map(([k, q]) => `- ${k}: ${q.instructions}`).join("\n");
  const schema = { type: "object", properties: Object.fromEntries(Object.keys(KEYWORD_QUESTIONS).map((k) => [k, { type: "boolean" }])), required: Object.keys(KEYWORD_QUESTIONS) };

  type R = { id: string; category: string; block: boolean; jev: { signals: Record<string, number>; latencyMs: number; cost: number; failedOpen: boolean }; gem: { flags: Record<string, boolean> | null; latencyMs: number; cost: number; error?: string } };
  const rows = await mapLimit(GATE_CASES, 3, async (c): Promise<R> => {
    const j = await screenKeyword(c.keyword, { timeoutMs: 20_000 });
    const started = performance.now();
    let flags: Record<string, boolean> | null = null;
    let cost = 0;
    let error: string | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await ai().models.generateContent({
          model,
          contents: [{ role: "user", parts: [{ text: `Screen this keyword for a t-shirt design generator (gossip/celebrity tea is allowed). Answer each question true/false.\n${questionsText}\n\nKEYWORD: ${JSON.stringify(c.keyword)}` }] }],
          config: { responseMimeType: "application/json", responseSchema: schema as never, temperature: 0 },
        });
        flags = JSON.parse(res.text ?? "{}");
        cost = tokenCost(model, res.usageMetadata?.promptTokenCount ?? 0, (res.usageMetadata?.candidatesTokenCount ?? 0) + (res.usageMetadata?.thoughtsTokenCount ?? 0));
        break;
      } catch (e) {
        error = String(e).slice(0, 100);
        if (!isTransientProviderError(e)) break;
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    return { id: c.id, category: c.category, block: c.block, jev: { signals: j.signals, latencyMs: j.latencyMs, cost: j.costUsd, failedOpen: j.failedOpen }, gem: { flags, latencyMs: performance.now() - started, cost, error } };
  });

  const score = (pred: (r: R) => boolean, subset: R[]) => {
    const bad = subset.filter((r) => r.block);
    const good = subset.filter((r) => !r.block);
    return { n: subset.length, accuracy: subset.filter((r) => pred(r) === r.block).length / subset.length, catchRate: bad.filter(pred).length / (bad.length || 1), falseBlockRate: good.filter(pred).length / (good.length || 1) };
  };
  const jevPred = (t: number) => (r: R) => decideFromSignals(r.jev.signals, t).blocked;
  const gemPred = (r: R) => Object.values(r.gem.flags ?? {}).some(Boolean);
  const dev = rows.filter((_, i) => i % 2 === 0);
  const held = rows.filter((_, i) => i % 2 === 1);
  const sweep = [0.1, 0.2, 0.3, 0.5, 0.7].map((t) => ({ t, dev: score(jevPred(t), dev), held: score(jevPred(t), held) }));
  const byCat: Record<string, { n: number; jevBlocked: number; gemBlocked: number }> = {};
  for (const r of rows) {
    const k = `${r.block ? "BLOCK" : "allow"}:${r.category}`;
    byCat[k] ??= { n: 0, jevBlocked: 0, gemBlocked: 0 };
    byCat[k].n++;
    if (jevPred(0.5)(r)) byCat[k].jevBlocked++;
    if (gemPred(r)) byCat[k].gemBlocked++;
  }
  const summary = {
    cases: rows.length,
    jev_t0_5_all: score(jevPred(0.5), rows),
    gemini_flash_lite_all: score(gemPred, rows.filter((r) => r.gem.flags)),
    geminiErrors: rows.filter((r) => !r.gem.flags).length,
    thresholdSweep: sweep,
    byCategory: byCat,
    jevLatencyMs: latencyStats(rows.map((r) => r.jev.latencyMs)),
    gemLatencyMs: latencyStats(rows.map((r) => r.gem.latencyMs)),
    jevCostPerCall: rows.reduce((s, r) => s + r.jev.cost, 0) / rows.length,
    gemCostPerCall: rows.reduce((s, r) => s + r.gem.cost, 0) / rows.length,
    jevFailedOpen: rows.filter((r) => r.jev.failedOpen).length,
  };
  console.log(JSON.stringify(summary, null, 1));
  save("gate", { summary, rows });
}
