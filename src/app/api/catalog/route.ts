import { NextResponse } from "next/server";
import { settings } from "@/config/settings";

export const runtime = "nodejs";

// Apparel-type + size options for the pick-time modal (customer) and review
// modal (admin) — one entry per enabled category in settings.printrove.
// products. category is now purely a post-generation choice (see the plan
// doc); this endpoint no longer feeds a brew-time product picker.
export async function GET() {
  if (settings.provider !== "printrove") {
    return NextResponse.json({ categories: [], colors: [] });
  }

  const enabled = settings.printrove.products.filter((p) => p.enabled);

  const categories = enabled.map((p) => ({
    category: p.category,
    label: p.categoryLabel,
    sizes: [...new Set(Object.keys(p.variantMap).map((k) => k.split("|")[1]))],
  }));

  const colors = [
    ...new Set(enabled.flatMap((p) => Object.keys(p.variantMap).map((k) => k.split("|")[0]))),
  ];

  return NextResponse.json({ categories, colors });
}
