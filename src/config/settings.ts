/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  wearthistea — APP SETTINGS
 * ─────────────────────────────────────────────────────────────────────────────
 *  Tune the knobs here. Anything you might change often is also wired to an
 *  environment variable so you can override per-environment without editing code.
 *
 *  Prompts live in a SEPARATE file you can iterate on freely:  src/config/prompts.ts
 * ─────────────────────────────────────────────────────────────────────────────
 */

const num = (v: string | undefined, fallback: number) =>
  v === undefined || v === "" || Number.isNaN(Number(v)) ? fallback : Number(v);

const bool = (v: string | undefined, fallback: boolean) =>
  v === undefined ? fallback : v.toLowerCase() === "true";

const list = (v: string | undefined, fallback: string[]) =>
  v && v.trim()
    ? v.split(",").map((s) => s.trim()).filter(Boolean)
    : fallback;

export const settings = {
  /** How many t-shirt options to generate per keyword. (You chose 5.) */
  optionsPerKeyword: num(process.env.OPTIONS_PER_KEYWORD, 5),

  /**
   * Active fulfillment provider. "printrove" (default) or "printify".
   * Switch with PRINT_PROVIDER in the env — no code change needed.
   */
  provider: (process.env.PRINT_PROVIDER ?? "printrove").toLowerCase(),

  gemini: {
    /** Near-instant text/SVG model for Stage 1. */
    flashLiteModel: process.env.GEMINI_FLASH_LITE_MODEL ?? "gemini-3.5-flash-lite",
    /** Text model that writes the design concepts (titles, phrases, visual ideas). */
    textModel: process.env.GEMINI_TEXT_MODEL ?? "gemini-3.7-flash",
    /**
     * High-quality fast image model for Stage 2 realization.
     * Verified: gemini-3-pro-image (Nano Banana Pro) has excellent typography.
     */
    imagenFastModel: process.env.GEMINI_IMAGEN_FAST_MODEL ?? "gemini-3-pro-image",
    /**
     * Image model that renders the artwork + product shots.
     * Verified: gemini-3.1-flash-image (Nano Banana 2) is the current stable fast choice.
     */
    imageModel: process.env.GEMINI_IMAGE_MODEL ?? "gemini-3.1-flash-image",
    /** Creativity for concept text. Higher = wilder. */
    textTemperature: num(process.env.GEMINI_TEXT_TEMPERATURE, 1.05),
  },

  /**
   * The GST-registered seller of record on every invoice (§3 of the plan:
   * you invoice the end customer directly — Printrove invoices you
   * separately, B2B, on its own cycle). Not real values — every field here
   * MUST be filled in with your actual registration before any invoice
   * generated with these placeholders is sent to a real customer.
   */
  seller: {
    businessName: process.env.SELLER_BUSINESS_NAME ?? "wearthistea (PLACEHOLDER — set SELLER_BUSINESS_NAME)",
    gstin: process.env.SELLER_GSTIN ?? "PLACEHOLDER-GSTIN-NOT-SET",
    address: process.env.SELLER_ADDRESS ?? "PLACEHOLDER — set SELLER_ADDRESS",
    /** Two-letter-code-free state name, matched against the buyer's state to pick CGST+SGST vs IGST. */
    state: process.env.SELLER_STATE ?? "Karnataka",
  },

  images: {
    /**
     * The clean, print-ready design is ALWAYS the one paid AI image per option
     * (it's what gets printed). This flag is kept for clarity.
     */
    generateDesignFile: bool(process.env.GENERATE_DESIGN_FILE, true),
    /**
     * Composite that design onto a t-shirt mockup for the grid preview.
     * This is FREE (no extra AI call) — set false to just show the raw design.
     */
    generateProductShot: bool(process.env.GENERATE_PRODUCT_SHOT, true),
  },

  printify: {
    /** Catalog search term used to auto-resolve the blank t-shirt blueprint. */
    blueprintQuery: process.env.PRINTIFY_BLUEPRINT_QUERY ?? "3001",
    /** Brand to match when several blueprints share the model number. */
    blueprintBrand: process.env.PRINTIFY_BLUEPRINT_BRAND ?? "Bella+Canvas",
    /** Sizes to enable (must match the catalog variant size names). */
    sizes: (process.env.PRINTIFY_SIZES ?? "S,M,L,XL,2XL")
      .split(",")
      .map((s) => s.trim()),
    /** Default garment colour to enable. */
    defaultColor: process.env.PRINTIFY_DEFAULT_COLOR ?? "Black",
    /**
     * Retail price in CENTS applied to every variant. This is your markup lever —
     * set it above Printify's base cost to control margin. (2999 = $29.99)
     */
    priceCents: num(process.env.PRINTIFY_PRICE_CENTS, 2999),
    /** Whether to push the product live to the connected sales channel on approval. */
    publish: bool(process.env.PRINTIFY_PUBLISH, true),
  },

  printrove: {
    /** Default new orders to Cash-on-Delivery. */
    cod: bool(process.env.PRINTROVE_COD, true),
    /** Countries offered in the checkout address form. */
    countries: list(process.env.PRINTROVE_COUNTRIES, [
      "India",
      "United States",
      "United Kingdom",
      "Canada",
      "Australia",
    ]),
    /**
     * The only garment categories we generate designs for and sell — half
     * sleeve, black only, capped at each product's flat-cost size tier (see
     * the business_base_price jump per size in Printrove's catalog; adding a
     * larger/older size back in means adding it here once its cost is priced
     * in, not just extending `variantMap`). Every id below (subtypeId,
     * sizeAttrId, colorAttrId, and each variantMap entry) was read live from
     * Printrove's catalog API — attribute ids are assigned per-product, NOT
     * globally (1/2 only happens to hold for Men's), so don't assume a
     * shared Size/Color attribute id when adding a category.
     *
     * print geometry: Printrove's design-canvas coordinate space is 10x the
     * product's front_print_width/height ("frame"). Men's/Women's/Kids all
     * have a frame bigger than the 3000x3000 design box in both dimensions,
     * so they use the documented centering recipe (left = (frameWidth -
     * boxWidth)/2, top = (frameHeight - boxHeight)/2 — see
     * scripts/test-printrove-centering.ts). Toddler's frame (2100x2340) is
     * SMALLER than that box, so its box had to shrink too — verified by
     * rendering live mockups at a couple of candidate sizes and eyeballing
     * placement, not computed from the formula alone.
     */
    products: [
      {
        category: "men",
        categoryLabel: "Men's Clothing",
        productLabel: "Half Sleeve Round Neck T-Shirt",
        subtypeId: 460,
        sizeAttrId: 1,
        colorAttrId: 2,
        // Capped at S–XL — cost jumps 165 -> 180/200/220/230 at 2XL–5XL.
        variantMap: { "Black|S": 269, "Black|M": 270, "Black|L": 271, "Black|XL": 272 } as Record<string, number>,
        print: { width: 3000, height: 3000, top: 1440, left: 840 },
        retailPrice: num(process.env.PRINTROVE_RETAIL_PRICE_MEN, 599),
        // Size used to build the one preview mockup for this category — a
        // representative middle size, not a real order. Mockups are proven
        // pixel-identical across sizes within a category (print placement
        // doesn't vary by size), so any size in variantMap would do.
        previewSize: "M",
        enabled: true,
      },
      {
        category: "women",
        categoryLabel: "Women's Clothing",
        productLabel: "Women's Half Sleeve Round Neck T-Shirt",
        subtypeId: 462,
        sizeAttrId: 5,
        colorAttrId: 6,
        // Capped at XS–XL — cost jumps 155 -> 165/180/200/220 at 2XL–5XL.
        variantMap: { "Black|XS": 335, "Black|S": 333, "Black|M": 332, "Black|L": 331, "Black|XL": 334 } as Record<string, number>,
        print: { width: 3000, height: 3000, top: 675, left: 240 },
        retailPrice: num(process.env.PRINTROVE_RETAIL_PRICE_WOMEN, 599),
        previewSize: "M",
        enabled: true,
      },
      {
        category: "toddler",
        categoryLabel: "Kid's Clothing — Toddler",
        productLabel: "Toddler Half Sleeve Round Neck T-Shirt",
        subtypeId: 560,
        sizeAttrId: 12,
        colorAttrId: 11,
        // Sizes are ages, not S/M/L. Capped at 1–4 — cost jumps 130 -> 150 at age 6.
        variantMap: { "Black|1": 636, "Black|2": 644, "Black|3": 652, "Black|4": 660 } as Record<string, number>,
        print: { width: 1800, height: 1800, top: 270, left: 150 },
        retailPrice: num(process.env.PRINTROVE_RETAIL_PRICE_TODDLER, 599),
        previewSize: "2",
        enabled: true,
      },
      {
        category: "kids",
        categoryLabel: "Kid's Clothing — Kids",
        productLabel: "Kids Half Sleeve Round Neck T-Shirt",
        subtypeId: 561,
        sizeAttrId: 14,
        colorAttrId: 13,
        // Sizes are ages, not S/M/L. Flat cost (150) across the offered range — no cap needed.
        variantMap: { "Black|8": 676, "Black|10": 684, "Black|12": 692, "Black|14": 700 } as Record<string, number>,
        print: { width: 3000, height: 3000, top: 675, left: 240 },
        retailPrice: num(process.env.PRINTROVE_RETAIL_PRICE_KIDS, 599),
        previewSize: "10",
        enabled: true,
      },
    ],
    /**
     * How long a fetched live order status (see printrove-order-status.ts)
     * is trusted before /account/orders fetches Printrove again. There's no
     * webhook — this is a customer-page-view-triggered read-through cache,
     * not a push, so this TTL is the only thing standing between a busy
     * customer refreshing their orders page and hammering Printrove's API.
     */
    orderStatusCacheTtlMs: num(process.env.ORDER_STATUS_CACHE_TTL_MS, 15 * 60 * 1000),
  },
} as const;

export type PrintroveProductConfig = (typeof settings)["printrove"]["products"][number];

/** Look up a supported category's product config, falling back to "men". */
export function printroveProduct(category?: string | null): PrintroveProductConfig {
  const products = settings.printrove.products;
  return (
    products.find((p) => p.category === category && p.enabled) ??
    products.find((p) => p.category === "men")!
  );
}

export type Settings = typeof settings;
