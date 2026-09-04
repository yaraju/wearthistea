import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCustomerSession, requireCustomer } from "@/lib/auth";

export const runtime = "nodejs";

// List the signed-in customer's saved addresses, most-recently-used first
// (default first). Used by /account and by the checkout snippet/switcher.
export async function GET(req: Request) {
  const denied = await requireCustomer(req);
  if (denied) return denied;
  const session = await getCustomerSession(req);

  const addresses = await prisma.address.findMany({
    where: { userId: session!.uid },
    orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
  });
  return NextResponse.json({ addresses });
}

// Field limits mirror the Customer schema in /api/designs/select — same
// shape, plus label/isDefault, minus email (that's the account's own email).
const Body = z.object({
  label: z.string().trim().max(40).optional().or(z.literal("")),
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(5).max(20),
  address1: z.string().trim().min(1).max(200),
  address2: z.string().trim().max(200).optional().or(z.literal("")),
  address3: z.string().trim().max(200).optional().or(z.literal("")),
  city: z.string().trim().max(80).optional().or(z.literal("")),
  state: z.string().trim().max(80).optional().or(z.literal("")),
  pincode: z.string().trim().max(20).optional().or(z.literal("")),
  country: z.string().trim().min(1).max(80),
  isDefault: z.boolean().optional(),
});

// Add a new saved address ("add another address" from checkout, or from
// /account directly). No edit/delete in this pass — see the plan doc.
export async function POST(req: Request) {
  const denied = await requireCustomer(req);
  if (denied) return denied;
  const session = await getCustomerSession(req);

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Please fill in the required address fields." }, { status: 400 });
  }

  const existingCount = await prisma.address.count({ where: { userId: session!.uid } });
  // First address is always the default, regardless of what was passed —
  // there must always be exactly one default once any address exists.
  const makeDefault = existingCount === 0 || body.isDefault === true;

  const address = await prisma.$transaction(async (tx) => {
    if (makeDefault) {
      await tx.address.updateMany({
        where: { userId: session!.uid, isDefault: true },
        data: { isDefault: false },
      });
    }
    return tx.address.create({
      data: {
        userId: session!.uid,
        label: body.label || null,
        name: body.name,
        phone: body.phone,
        address1: body.address1,
        address2: body.address2 || null,
        address3: body.address3 || null,
        city: body.city || null,
        state: body.state || null,
        pincode: body.pincode || null,
        country: body.country,
        isDefault: makeDefault,
      },
    });
  });

  return NextResponse.json({ ok: true, address });
}
