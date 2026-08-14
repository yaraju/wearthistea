import { NextResponse } from "next/server";
import { getCategories, getParentProducts, getStockCount, PrintroveProduct } from "@/lib/printrove";
import { settings } from "@/config/settings";
import { CatalogCategory } from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  console.log("Catalog API called. Provider:", settings.provider);
  if (settings.provider !== "printrove") {
    return NextResponse.json({
      categories: [],
      inStock: {}
    });
  }

  try {
    const [categories, parentProducts, stock] = await Promise.all([
      getCategories(),
      getParentProducts(),
      getStockCount({ availability: "in_stock", per_page: 100 }),
    ]);

    console.log(`Fetched ${categories.length} categories, ${parentProducts.length} parent products, ${stock.length} stock items.`);

    // Map parent products to their categories
    const categoryMap = categories.reduce((acc, cat) => {
      acc[cat.id] = { ...cat, products: [] };
      return acc;
    }, {} as Record<number, CatalogCategory & { products: PrintroveProduct[] }>);

    parentProducts.forEach(p => {
      if (categoryMap[p.category_id]) {
        categoryMap[p.category_id].products.push(p);
      }
    });

    // Group in-stock colors by product_id
    const inStock = stock.reduce((acc, item) => {
      if (!acc[item.product_id]) acc[item.product_id] = new Set();
      acc[item.product_id].add(item.color);
      return acc;
    }, {} as Record<number, Set<string>>);

    // Filter out categories that have no products
    const resultCategories = Object.values(categoryMap)
      .map((cat) => ({
        ...cat,
        products: (cat.products as PrintroveProduct[])
          .map((p) => {
            const colors = inStock[p.id] ? Array.from(inStock[p.id]) : [];
            
            return {
              id: p.id,
              name: p.name,
              colors: colors.length > 0 ? colors : ["Black", "White"] // Fallback colors if we can't get stock
            };
          })
          .filter((p) => p.colors.length > 0)
      }))
      .filter((cat) => cat.products.length > 0);

    return NextResponse.json({
      categories: resultCategories
    });
  } catch (err) {
    console.error("Catalog API error:", err);
    return NextResponse.json({ error: "Failed to fetch catalog" }, { status: 500 });
  }
}
