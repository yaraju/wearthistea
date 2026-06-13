import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const Body = z.object({ designId: z.string().min(1) });

export async function POST(req: Request) {
  let designId: string;
  try {
    designId = Body.parse(await req.json()).designId;
  } catch {
    return NextResponse.json({ error: "designId is required." }, { status: 400 });
  }

  const updated = await prisma.design.update({
    where: { id: designId },
    data: { status: "rejected", selected: false },
  });
  return NextResponse.json({ ok: true, design: updated });
}
