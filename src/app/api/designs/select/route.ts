import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { settings } from "@/config/settings";
import { realizeDesign } from "@/lib/realize";

export const runtime = "nodejs";

const Customer = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(160).optional().or(z.literal("")),
  phone: z.string().trim().min(5).max(20),
  address1: z.string().trim().min(1).max(200),
  address2: z.string().trim().max(200).optional().or(z.literal("")),
  city: z.string().trim().max(80).optional().or(z.literal("")),
  state: z.string().trim().max(80).optional().or(z.literal("")),
  pincode: z.string().trim().max(20).optional().or(z.literal("")),
  country: z.string().trim().min(1).max(80),
});

const Body = z.object({
  designId: z.string().min(1),
  size: z.string().trim().min(1).max(40),
  color: z.string().trim().min(1).max(40),
  quantity: z.number().int().min(1).max(10).default(1),
  customer: Customer.optional(),
});

// User picks a design on the landing page + fills in the checkout → it enters
// the /admin approval queue with the order details attached.
export async function POST(req: Request) {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json(
      { error: "Please choose a size/color and fill in the required details." },
      { status: 400 }
    );
  }

  // Printrove places a real shipping order, so recipient details are required.
  if (settings.provider !== "printify" && !body.customer) {
    return NextResponse.json(
      { error: "Shipping details are required to place this order." },
      { status: 400 }
    );
  }

  const design = await prisma.design.findUnique({ where: { id: body.designId } });
  if (!design)
    return NextResponse.json({ error: "Design not found." }, { status: 404 });

  if (design.status === "failed")
    return NextResponse.json(
      { error: "This design failed to render — try regenerating." },
      { status: 409 }
    );

  // Realize (or re-realize) when: this is a legacy row that never got past
  // Stage 1 preview, or the buyer picked a different garment color at
  // checkout than the one the art was actually generated for — designImage()
  // picks ink color (light-on-dark vs dark-on-light) from the garment color,
  // so a color change can otherwise ship art that's invisible on the tee.
  const colorChanged = Boolean(design.variantColor) && design.variantColor !== body.color;
  if (design.status !== "generated" || colorChanged) {
    try {
      await prisma.design.update({
        where: { id: body.designId },
        data: {
          variantSize: body.size,
          variantColor: body.color,
        }
      });
      // realizeDesign() catches its own errors and returns a status:"failed"
      // row rather than throwing — it never reaches the catch block below on
      // its own, so the failure has to be read from its return value.
      const realized = await realizeDesign(body.designId);
      if (realized.status === "failed") {
        return NextResponse.json(
          { error: realized.errorMessage || "Could not finalize the high-res design. Please try again." },
          { status: 500 }
        );
      }
    } catch (err) {
      console.error("[Realize] Failed during selection:", err);
      return NextResponse.json(
        { error: "Could not finalize the high-res design. Please try again." },
        { status: 500 }
      );
    }
  }

  const c = body.customer;
  const updated = await prisma.design.update({
    where: { id: body.designId },
    data: {
      status: "pending",
      selected: true,
      variantSize: body.size,
      variantColor: body.color,
      quantity: body.quantity,
      cod: settings.printrove.cod,
      recipientName: c?.name ?? null,
      recipientEmail: c?.email || null,
      recipientPhone: c?.phone ?? null,
      addressLine1: c?.address1 ?? null,
      addressLine2: c?.address2 || null,
      city: c?.city || null,
      state: c?.state || null,
      pincode: c?.pincode || null,
      country: c?.country ?? null,
    },
  });
  await prisma.batch.update({
    where: { id: design.batchId },
    data: { status: "queued" },
  });

  return NextResponse.json({ ok: true, design: updated });
}
