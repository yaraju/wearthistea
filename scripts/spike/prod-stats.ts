/**
 * READ-ONLY look at the shared prod DB (user-approved; no active users) to
 * size first-pass yield and failure modes for the Jev/model-swap spike.
 * Only groupBy/findMany/count are used — nothing is written. Prints
 * aggregates and issue-category counts, no customer data.
 */
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  const total = await prisma.design.count();
  const byValidation = await prisma.design.groupBy({ by: ["validationStatus"], _count: true });
  const byStatus = await prisma.design.groupBy({ by: ["status"], _count: true });
  const byStyle = await prisma.design.groupBy({ by: ["style"], _count: true });
  const byColor = await prisma.design.groupBy({ by: ["variantColor"], _count: true });
  console.log({ total, byValidation, byStatus, byStyle, byColor });

  const lineage = await prisma.design.aggregate({
    _avg: { validationFixAttempts: true, validationRegenAttempts: true },
    _sum: { validationFixAttempts: true, validationRegenAttempts: true },
  });
  console.log("attempts", lineage);

  const withNotes = await prisma.design.findMany({
    where: { validationNotes: { not: null } },
    select: { id: true, validationStatus: true, validationNotes: true, createdAt: true, style: true },
    orderBy: { createdAt: "desc" },
    take: 400,
  });
  const cats: Record<string, number> = {};
  let n = 0;
  for (const d of withNotes) {
    let issues: string[] = [];
    try {
      const j = JSON.parse(d.validationNotes!);
      const arr = j.issues ?? j.verdict?.issues ?? [];
      if (Array.isArray(arr)) issues = arr.filter((x: unknown): x is string => typeof x === "string");
    } catch {
      issues = [d.validationNotes!.slice(0, 200)];
    }
    if (issues.length === 0) continue;
    n++;
    const seen = new Set<string>();
    for (const i of issues) {
      const k = /checker|transparen|background|artifact/i.test(i)
        ? "background/checkerboard"
        : /garment|t-?shirt|collar|sleeve|mockup/i.test(i)
          ? "garment-in-art"
          : /extra|unrequested|unauthori[sz]ed|additional text|readable text/i.test(i)
            ? "extra-text"
            : /spell|legib|phrase|misspell|text/i.test(i)
              ? "phrase/text"
              : /crop/i.test(i)
                ? "cropped"
                : /contrast|detail|blurry|print|outline|sticker/i.test(i)
                  ? "print-quality"
                  : /ink|color/i.test(i)
                    ? "ink/color"
                    : "other";
      seen.add(k);
    }
    for (const k of seen) cats[k] = (cats[k] ?? 0) + 1;
  }
  console.log(`designs with parseable issues: ${n} of ${withNotes.length} notes`, cats);
  const sample = withNotes.slice(0, 3).map((d) => ({ s: d.validationStatus, notes: d.validationNotes!.slice(0, 300) }));
  console.log("sample notes", sample);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
