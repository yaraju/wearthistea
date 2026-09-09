import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin, getAdminSession } from "@/lib/auth";
import { invalidateRateLimitSettingsCache, DEFAULT_RATE_LIMIT_CONFIG } from "@/lib/rate-limit";

export const runtime = "nodejs";

// Live-editable image-generation rate limits — see /admin/rate-limits and
// src/lib/rate-limit.ts. GET returns the current config + overrides; PATCH
// updates the singleton config row (never generates a redeploy).
export async function GET(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const [config, overrides] = await Promise.all([
    prisma.rateLimitConfig.findUnique({ where: { id: "singleton" } }),
    prisma.rateLimitOverride.findMany({ orderBy: { email: "asc" } }),
  ]);

  return NextResponse.json({ config: config ?? { id: "singleton", ...DEFAULT_RATE_LIMIT_CONFIG }, overrides });
}

const Body = z.object({
  windowMs: z.number().int().min(60_000).max(7 * 24 * 60 * 60 * 1000),
  maxAnonymous: z.number().int().min(0).max(100_000),
  maxSignedIn: z.number().int().min(0).max(100_000),
  maxAdmin: z.number().int().min(0).max(1_000_000),
});

export async function PATCH(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const session = await getAdminSession(req);

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid rate-limit values." }, { status: 400 });
  }

  const config = await prisma.rateLimitConfig.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", ...body, updatedByEmail: session!.email ?? null },
    update: { ...body, updatedByEmail: session!.email ?? null },
  });
  invalidateRateLimitSettingsCache();

  return NextResponse.json({ ok: true, config });
}
