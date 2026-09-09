import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { invalidateRateLimitSettingsCache } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const { id } = await ctx.params;
  await prisma.rateLimitOverride.delete({ where: { id } }).catch(() => null);
  invalidateRateLimitSettingsCache();

  return NextResponse.json({ ok: true });
}
