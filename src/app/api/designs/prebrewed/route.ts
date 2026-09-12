import { NextResponse } from "next/server";
import { z } from "zod";
import { searchDesignsByText } from "@/lib/design-search";
import { toDesignMatchDTOs } from "@/lib/design-match-dto";

export const runtime = "nodejs";

const Body = z.object({ keyword: z.string().trim().min(2).max(280) });

/**
 * Semantic matches for the "pre-brewed" section of the brew page — a
 * fallback for impatient users, shown below (never above) the fresh-brew
 * grid. Matches regardless of admin approval state (the confirmed hybrid
 * decision): each match's reviewBadge tells the customer whether it's
 * "taste-tested" or still "pending-taste-test" — DesignProduct.approvalStatus
 * already gates actual fulfillment either way (see design-product-review.ts),
 * so surfacing an unreviewed match here is exactly as safe as a freshly
 * brewed design that hasn't been reviewed yet.
 */
export async function POST(req: Request) {
  let keyword: string;
  try {
    keyword = Body.parse(await req.json()).keyword;
  } catch {
    return NextResponse.json({ error: "keyword is required." }, { status: 400 });
  }

  const hits = await searchDesignsByText(keyword, {
    limit: 6,
    fields: ["keyword"],
    onlyStatus: "generated",
    excludeAllRejected: true,
  });

  return NextResponse.json({ matches: await toDesignMatchDTOs(hits) });
}
