/**
 * Manual smoke test for src/lib/design-search.ts — takes a literal query
 * string, runs searchDesignsByText, prints the top hits with distance and
 * matchedField. Doubles as a smoke test for the LLM-judge search contract
 * (GET /api/admin/designs/search) before wiring the actual endpoint.
 *
 *   npx tsx scripts/test-design-search.ts "mercury is in microwave"
 */
import dotenv from "dotenv";
dotenv.config();

import { prisma } from "../src/lib/prisma";
import { searchDesignsByText } from "../src/lib/design-search";

async function main() {
  const query = process.argv.slice(2).join(" ");
  if (!query) {
    console.error('Usage: npx tsx scripts/test-design-search.ts "<query text>"');
    process.exit(1);
  }

  const hits = await searchDesignsByText(query, { limit: 10 });
  console.log(`Query: "${query}" — ${hits.length} hit(s)\n`);

  if (hits.length === 0) {
    console.log("(no hits)");
    return;
  }

  const designs = await prisma.design.findMany({
    where: { id: { in: hits.map((h) => h.designId) } },
    select: { id: true, title: true, phrase: true, slug: true },
  });
  const byId = new Map(designs.map((d) => [d.id, d]));

  for (const hit of hits) {
    const d = byId.get(hit.designId);
    console.log(
      `distance=${hit.distance.toFixed(4)} field=${hit.matchedField}  "${d?.title}" — "${d?.phrase}"  (${hit.designId})`
    );
  }
}

main()
  .catch((err) => {
    console.error("Search failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
