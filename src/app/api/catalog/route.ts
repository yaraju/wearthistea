import { NextResponse } from "next/server";
import { settings } from "@/config/settings";

export const runtime = "nodejs";

// The landing page's category/product picker. Deliberately NOT a live fetch
// of Printrove's full catalog anymore — that offered every product Printrove
// sells (hoodies, joggers, a dozen colors...), most of which have never been
// tested here. This returns only the categories/products actually wired up
// in settings.printrove.products (half sleeve, black only, for now).
export async function GET() {
  if (settings.provider !== "printrove") {
    return NextResponse.json({ categories: [] });
  }

  const categories = settings.printrove.products
    .filter((p) => p.enabled)
    .map((p) => ({
      id: p.subtypeId,
      name: p.categoryLabel,
      products: [
        {
          id: p.subtypeId,
          name: p.productLabel,
          colors: ["Black"],
        },
      ],
    }));

  return NextResponse.json({ categories });
}
