import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

// Admin queue feed. ?status=pending (default) filters to items awaiting approval.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const status = url.searchParams.get("status");

  try {
    const designs = await prisma.design.findMany({
      where:
        status && status !== "all"
          ? { status }
          : { status: { not: "generated" } },
      orderBy: { updatedAt: "desc" },
      include: { batch: { select: { keyword: true, createdAt: true } } },
      take: 200,
    });

    const counts = await prisma.design.groupBy({
      by: ["status"],
      _count: { _all: true },
    });

    return NextResponse.json({
      designs: designs.map(({ designImageData, ...d }) => ({
        ...d,
        hasImageData: Boolean(designImageData),
      })),
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Database error.";
    const hint = /database|connect|P10\d\d|ECONN/i.test(message)
      ? "Is DATABASE_URL set and did you run `npx prisma db push`?"
      : undefined;
    return NextResponse.json({ error: message, hint }, { status: 500 });
  }
}
