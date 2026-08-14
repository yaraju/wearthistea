import { NextResponse } from "next/server";
import { z } from "zod";
import { realizeDesign } from "@/lib/realize";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  designId: z.string(),
});

export async function POST(req: Request) {
  let body;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Design ID is required." }, { status: 400 });
  }

  const { designId } = body;

  try {
    const start = Date.now();
    const realized = await realizeDesign(designId);
    const duration = Date.now() - start;

    console.log(`[Stage 2] Design ${designId} realized in ${duration}ms`);

    return NextResponse.json({
      success: true,
      design: realized,
      latencyMs: duration,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Realization failed.";
    console.error(`[Stage 2] Failed for design ${designId}:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
