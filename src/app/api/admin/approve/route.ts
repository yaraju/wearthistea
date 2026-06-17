import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getProvider } from "@/lib/print-provider";
import { readImageAsBase64 } from "@/lib/storage";
import { settings } from "@/config/settings";

export const runtime = "nodejs";
export const maxDuration = 120;

const Body = z.object({ designId: z.string().min(1) });

// Human approval → push to the active provider.
//   Printrove: upload design → create product → place a (COD) order.
//   Printify:  upload design → create product → publish to the sales channel.
export async function POST(req: Request) {
  let designId: string;
  try {
    designId = Body.parse(await req.json()).designId;
  } catch {
    return NextResponse.json({ error: "designId is required." }, { status: 400 });
  }

  const design = await prisma.design.findUnique({ where: { id: designId } });
  if (!design)
    return NextResponse.json({ error: "Design not found." }, { status: 404 });

  const printPath = design.designImagePath || design.productImagePath;
  if (!printPath)
    return NextResponse.json(
      { error: "This design has no artwork file to print." },
      { status: 409 }
    );

  const provider = getProvider();

  // Order-placing providers need recipient + a chosen variant.
  if (provider.name !== "printify") {
    if (!design.recipientName || !design.addressLine1 || !design.country)
      return NextResponse.json(
        { error: "This design has no shipping details — it can't be ordered." },
        { status: 409 }
      );
    if (!design.variantSize || !design.variantColor)
      return NextResponse.json(
        { error: "This design has no size/color selected." },
        { status: 409 }
      );
  }

  const priceCents =
    provider.name === "printify"
      ? settings.printify.priceCents
      : settings.printrove.retailPrice;

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
      referenceNumber: design.id,
      title: design.title,
      description,
      designBase64,
      designFileName: `${design.id}.png`,
      priceCents: settings.printify.priceCents,
      quantity: design.quantity ?? 1,
      variant: {
        size: design.variantSize ?? "",
        color: design.variantColor ?? "",
      },
      customer: design.recipientName
        ? {
            name: design.recipientName,
            email: design.recipientEmail,
            phone: design.recipientPhone ?? "",
            address1: design.addressLine1 ?? "",
            address2: design.addressLine2,
            address3: design.addressLine3,
            city: design.city,
            state: design.state,
            pincode: design.pincode,
            country: design.country ?? "",
          }
        : null,
      cod: design.cod,
    });

    const updated = await prisma.design.update({
      where: { id: designId },
      data: {
        status: "published",
        priceCents,
        printifyProductId: result.productId,
        printifyUrl: result.url,
        providerOrderId: result.orderId,
        trackingNumber: result.trackingNumber,
        errorMessage: null,
      },
    });

    return NextResponse.json({ ok: true, design: updated });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : `${provider.name} push failed.`;
    await prisma.design.update({
      where: { id: designId },
      data: { status: "failed", errorMessage: message },
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
