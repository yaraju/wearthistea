import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getProvider } from "@/lib/print-provider";
import { readImageAsBase64 } from "@/lib/storage";
import { settings, printroveProduct } from "@/config/settings";

export const runtime = "nodejs";
export const maxDuration = 120;

const Body = z.object({ orderId: z.string().min(1) });

// Human approval → push to the active provider.
//   Printrove: upload design → create product → place a (COD) order.
//   Printify:  upload design → create product → publish to the sales channel.
export async function POST(req: Request) {
  let orderId: string;
  try {
    orderId = Body.parse(await req.json()).orderId;
  } catch {
    return NextResponse.json({ error: "orderId is required." }, { status: 400 });
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { design: true },
  });
  if (!order)
    return NextResponse.json({ error: "Order not found." }, { status: 404 });

  const design = order.design;
  const printPath = design.designImagePath || design.productImagePath;
  if (!printPath)
    return NextResponse.json(
      { error: "This design has no artwork file to print." },
      { status: 409 }
    );

  const provider = getProvider();

  // Order-placing providers need recipient + a chosen variant.
  if (provider.name !== "printify") {
    if (!order.recipientName || !order.addressLine1 || !order.country)
      return NextResponse.json(
        { error: "This order has no shipping details — it can't be placed." },
        { status: 409 }
      );
    if (!order.variantSize || !order.variantColor)
      return NextResponse.json(
        { error: "This order has no size/color selected." },
        { status: 409 }
      );
  }

  const priceCents =
    provider.name === "printify"
      ? settings.printify.priceCents
      : printroveProduct(order.productCategory).retailPrice;

  try {
    let designBase64: string;
    try {
      designBase64 = await readImageAsBase64(printPath);
    } catch {
      // File missing (e.g. ephemeral Railway filesystem after a redeploy).
      // Fall back to the base64 copy stored in the database.
      if (!design.designImageData) {
        throw new Error(
          "Artwork file is missing and no database copy exists. Re-generate this design."
        );
      }
      designBase64 = design.designImageData;
    }
    const description =
      design.blurb ??
      `${design.phrase} — an original wearthistea drop. ${design.visualConcept}`;

    const result = await provider.fulfill({
      referenceNumber: order.id,
      title: design.title,
      description,
      designBase64,
      designFileName: `${design.id}.png`,
      priceCents,
      quantity: order.quantity ?? 1,
      variant: {
        size: order.variantSize ?? "",
        color: order.variantColor ?? "",
      },
      category: order.productCategory,
      customer: order.recipientName
        ? {
            name: order.recipientName,
            email: order.recipientEmail,
            phone: order.recipientPhone ?? "",
            address1: order.addressLine1 ?? "",
            address2: order.addressLine2,
            address3: order.addressLine3,
            city: order.city,
            state: order.state,
            pincode: order.pincode,
            country: order.country ?? "",
          }
        : null,
      cod: order.cod,
    });

    const updated = await prisma.order.update({
      where: { id: orderId },
      data: {
        status: "published",
        unitPriceCents: priceCents,
        printroveProductId: result.productId,
        printroveUrl: result.url,
        printroveOrderId: result.orderId,
        trackingNumber: result.trackingNumber,
        errorMessage: null,
      },
    });

    return NextResponse.json({ ok: true, order: updated });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : `${provider.name} push failed.`;
    await prisma.order.update({
      where: { id: orderId },
      data: { status: "failed", errorMessage: message },
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
