import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { finalizeDesignRender } from "@/lib/design-render";
import { checkGenerateRateLimit } from "@/lib/rate-limit";
import { langfuse, getTraceId } from "@/lib/langfuse";
import { friendlyError } from "@/lib/error-messages";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  designId: z.string(),
});

export async function POST(req: Request) {
  // Same budget pool as /api/generate and /api/realize — this route also
  // triggers a full paid image render.
  const rateLimit = await checkGenerateRateLimit(req);
  if (!rateLimit.ok) {
    return NextResponse.json(
      { error: "You've hit the free-generation limit for now — try again in a bit." },
      { status: 429 }
    );
  }

  let body;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Missing designId." }, { status: 400 });
  }

  const { designId } = body;

  const traceId = getTraceId(req);
  const trace = langfuse.trace({
    name: "generate-retry-api",
    id: traceId,
    input: body,
  });

  const design = await prisma.design.findUnique({
    where: { id: designId },
  });

  if (!design) {
    return NextResponse.json({ error: "Design not found." }, { status: 404 });
  }

  const result = await finalizeDesignRender(design, trace, rateLimit);

  if (!result.ok) {
    const message = result.transient
      ? "Our design engine is swamped right now — try again in a moment."
      : friendlyError(result.error);
    return NextResponse.json({ error: message }, { status: result.transient ? 503 : 500 });
  }

  // Never send the full-res print file to a customer-facing caller — only
  // the downscaled preview. designImagePath/productImagePath stay
  // server-side (read by fulfillment.ts / design-products.ts).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { designImagePath, productImagePath, designImageData, backDesignImagePath, ...safeDesign } = result.design;
  return NextResponse.json({ design: safeDesign });
}
