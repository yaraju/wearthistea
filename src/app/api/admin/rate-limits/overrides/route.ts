import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin, getAdminSession } from "@/lib/auth";
import { invalidateRateLimitSettingsCache } from "@/lib/rate-limit";

export const runtime = "nodejs";

const Body = z.object({
  email: z.string().trim().email(),
  maxPerWindow: z.number().int().min(0).max(100_000),
  note: z.string().trim().max(500).optional(),
});

// Per-email override of the signed-in tier's rate limit — see
// RateLimitOverride in prisma/schema.prisma. Upserts by email, so re-posting
// an existing email edits it rather than erroring.
export async function POST(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const session = await getAdminSession(req);

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "A valid email and max-per-window are required." }, { status: 400 });
  }

  const email = body.email.toLowerCase();
  const override = await prisma.rateLimitOverride.upsert({
    where: { email },
    create: {
      email,
      maxPerWindow: body.maxPerWindow,
      note: body.note || null,
      updatedByEmail: session!.email ?? null,
    },
    update: {
      maxPerWindow: body.maxPerWindow,
      note: body.note || null,
      updatedByEmail: session!.email ?? null,
    },
  });
  invalidateRateLimitSettingsCache();

  return NextResponse.json({ ok: true, override });
}
