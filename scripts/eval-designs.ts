/**
 * Phase 2 quality eval harness.
 *
 * Generates real designs for a fixed set of representative "tea" keywords
 * and grades each one with prompts.imageReview() (a multimodal QA prompt
 * that was already written in prompts.ts but never wired up anywhere).
 * Reports a pass rate and a breakdown of failure reasons — including how
 * often the model draws a garment/mockup into what's supposed to be a
 * graphic-only, transparent print file, which is a live open question for
 * the design-quality-improvement-plan.md rollout.
 *
 * Usage: npx tsx scripts/eval-designs.ts [--style raster|svg] [--per N]
 * Costs real Gemini API calls (image generation + review) — keep the
 * keyword list and --per small unless you specifically want a bigger run.
 */
import type { Concept } from "../src/config/prompts";
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const { ai, generateBatch } = await import("../src/lib/gemini");
  const { prompts } = await import("../src/config/prompts");
  const { settings } = await import("../src/config/settings");
  const { default: sharp } = await import("sharp");

  const styleArgIdx = process.argv.indexOf("--style");
  const style = (styleArgIdx >= 0 ? process.argv[styleArgIdx + 1] : "raster") as "raster" | "svg";
  const perArgIdx = process.argv.indexOf("--per");
  const perKeyword = perArgIdx >= 0 ? Number(process.argv[perArgIdx + 1]) : 2;
  const keywordsArgIdx = process.argv.indexOf("--keywords");
  const keywordCount = keywordsArgIdx >= 0 ? Number(process.argv[keywordsArgIdx + 1]) : undefined;

  const ALL_KEYWORDS = [
    "mercury is in microwave",
    "office drama: someone replied-all",
    "my situationship has a podcast now",
    "the group chat finally imploded",
    "my roommate ate my labeled food again",
    "he liked her photo from 3 years ago",
    "someone screenshotted the whole chat",
    "my coworker microwaved fish again",
  ];
  const KEYWORDS = keywordCount ? ALL_KEYWORDS.slice(0, keywordCount) : ALL_KEYWORDS;

  interface Row {
    keyword: string;
    title: string;
    usable: boolean;
    needsRegeneration: boolean;
    issues: string[];
    hasGarmentIssue: boolean;
    // Ground truth from the actual pixel data, not the vision model's guess —
    // a vision model is shown a flattened/composited view and can't perceive
    // alpha, so its "background is not transparent" claims are unreliable and
    // get cross-checked against this instead of trusted at face value.
    actuallyHasAlpha?: boolean;
    genError?: string;
    reviewError?: string;
  }

  async function reviewImage(concept: Concept, imageB64: string) {
    const res = await ai().models.generateContent({
      model: settings.gemini.textModel,
      contents: [
        {
          role: "user",
          parts: [
            { text: prompts.imageReview(concept) },
            { inlineData: { mimeType: "image/png", data: imageB64 } },
          ],
        },
      ],
      config: { responseMimeType: "application/json", temperature: 0 },
    });
    const text = res.text;
    if (!text) throw new Error("Review model returned no text.");
    return JSON.parse(text) as {
      usable: boolean;
      issues: string[];
      needsRegeneration: boolean;
      regenerationPrompt: string;
    };
  }

  const rows: Row[] = [];

  for (const keyword of KEYWORDS) {
    console.log(`\n=== "${keyword}" (style=${style}, n=${perKeyword}) ===`);
    const items = await generateBatch(keyword, perKeyword, { style });
    for (const item of items) {
      if (item.error || !item.imageB64) {
        console.log(`  [GEN FAILED] ${item.title}: ${item.error}`);
        rows.push({
          keyword,
          title: item.title,
          usable: false,
          needsRegeneration: true,
          issues: [],
          hasGarmentIssue: false,
          genError: item.error,
        });
        continue;
      }
      try {
        const review = await reviewImage(item, item.imageB64);
        const issues = review.issues ?? [];
        const hasGarmentIssue = issues.some((i) => /t-?shirt|mockup|garment|collar|sleeve/i.test(i));
        const claimsOpaque = issues.some((i) => /not transparent|opaque background/i.test(i));
        const { hasAlpha } = await sharp(Buffer.from(item.imageB64, "base64")).metadata();
        rows.push({
          keyword,
          title: item.title,
          usable: review.usable,
          needsRegeneration: review.needsRegeneration,
          issues,
          hasGarmentIssue,
          actuallyHasAlpha: hasAlpha,
        });
        console.log(
          `  ${review.usable ? "OK  " : "FAIL"} ${item.title}${hasGarmentIssue ? "  [GARMENT-IN-GRAPHIC]" : ""}${
            claimsOpaque ? `  [review says opaque; actual hasAlpha=${hasAlpha}]` : ""
          }`
        );
        if (issues.length) console.log(`       issues: ${issues.join("; ")}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  [REVIEW FAILED] ${item.title}: ${msg}`);
        rows.push({
          keyword,
          title: item.title,
          usable: false,
          needsRegeneration: false,
          issues: [],
          hasGarmentIssue: false,
          reviewError: msg,
        });
      }
    }
  }

  const total = rows.length;
  const pct = (n: number) => (total ? ((n / total) * 100).toFixed(0) : "0");
  const garmentCount = rows.filter((r) => r.hasGarmentIssue).length;
  const failCount = rows.filter((r) => r.needsRegeneration).length;
  const genErrors = rows.filter((r) => r.genError).length;
  const claimedOpaque = rows.filter((r) => r.issues.some((i) => /not transparent|opaque background/i.test(i)));
  const falseOpaqueClaims = claimedOpaque.filter((r) => r.actuallyHasAlpha).length;

  console.log(`\n=== SUMMARY (n=${total}) ===`);
  console.log(`Generation failures: ${genErrors}/${total}`);
  console.log(`Garment/mockup-in-graphic rate: ${garmentCount}/${total} (${pct(garmentCount)}%)`);
  console.log(`Overall needsRegeneration rate (raw): ${failCount}/${total} (${pct(failCount)}%)`);
  console.log(
    `"Background not transparent" claims: ${claimedOpaque.length}/${total} — of those, ${falseOpaqueClaims} actually ` +
      `had a real alpha channel (sharp hasAlpha=true). The vision model reviews a flattened/composited view and can't ` +
      `perceive alpha, so this specific check is unreliable — verify transparency programmatically, not via imageReview.`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
