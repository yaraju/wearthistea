import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";

export const runtime = "nodejs";

const Body = z.object({ orderId: z.string().min(1) });

export async function POST(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  let orderId: string;
  try {
    orderId = Body.parse(await req.json()).orderId;
  } catch {
    return NextResponse.json({ error: "orderId is required." }, { status: 400 });
  }

  const updated = await prisma.order.update({
    where: { id: orderId },
    data: { status: "rejected" },
  });
  return NextResponse.json({ ok: true, order: updated });
}
