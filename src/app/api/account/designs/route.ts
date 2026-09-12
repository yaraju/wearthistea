import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCustomer, getCustomerSession } from "@/lib/auth";
import { decodeCursor, encodeCursor, cursorWhereClause } from "@/lib/keyset-pagination";

export const runtime = "nodejs";

const PAGE_SIZE = 24;

/** A signed-in customer's own brewed designs ("your brews") — keyset paginated. */
export async function GET(req: Request) {
  const denied = await requireCustomer(req);
  if (denied) return denied;
  const session = await getCustomerSession(req);

  const url = new URL(req.url);
  const cursor = decodeCursor(url.searchParams.get("cursor"));
  const limit = Math.min(Number(url.searchParams.get("limit")) || PAGE_SIZE, 100);

  const rows = await prisma.design.findMany({
    where: { createdByUserId: session!.uid, ...cursorWhereClause(cursor) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      slug: true,
      title: true,
      phrase: true,
      status: true,
      productPreviewImagePath: true,
      designPreviewImagePath: true,
      variantColor: true,
      createdAt: true,
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return NextResponse.json({
    designs: page.map((d) => ({ ...d, createdAt: d.createdAt.toISOString() })),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null,
  });
}
