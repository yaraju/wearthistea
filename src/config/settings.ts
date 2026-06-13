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

/** Parse a JSON object env var into a { "Color|Size": variantId } number map. */
const jsonMap = (v: string | undefined): Record<string, number> => {
  if (!v) return {};
  try {
    const obj = JSON.parse(v) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, val] of Object.entries(obj)) {
      const n = Number(val);
      if (!Number.isNaN(n)) out[k] = n;
    }
    return out;
  } catch {
    return {};
  }
};

export const settings = {
  /** How many t-shirt options to generate per keyword. (You chose 5.) */
  optionsPerKeyword: num(process.env.OPTIONS_PER_KEYWORD, 5),

  /**
   * Active fulfillment provider. "printrove" (default) or "printify".
   * Switch with PRINT_PROVIDER in the env — no code change needed.
   */
  provider: (process.env.PRINT_PROVIDER ?? "printrove").toLowerCase(),

  gemini: {
    /** Text model that writes the design concepts (titles, phrases, visual ideas). */
    textModel: process.env.GEMINI_TEXT_MODEL ?? "gemini-2.5-flash",
    /**
     * Image model that renders the artwork + product shots.
     * "Nano Banana" family => gemini-2.5-flash-image (default).
     * You can also point this at an Imagen model (e.g. imagen-3.0-generate-002);
     * the code auto-detects "imagen" in the name and uses the Images API instead.
     */
    imageModel: process.env.GEMINI_IMAGE_MODEL ?? "gemini-2.5-flash-image",
    /** Creativity for concept text. Higher = wilder. */
    textTemperature: num(process.env.GEMINI_TEXT_TEMPERATURE, 1.05),
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
    /** Base product id from Printrove's catalog — the blank you print on ("default model"). */
    productId: num(process.env.PRINTROVE_PRODUCT_ID, 0),
    /** Sizes offered in checkout (fallback when no variant map is set). */
    sizes: list(process.env.PRINTROVE_SIZES, ["S", "M", "L", "XL", "2XL"]),
    /** Colors offered in checkout (fallback when no variant map is set). */
    colors: list(process.env.PRINTROVE_COLORS, ["Black"]),
    /**
     * Maps "Color|Size" -> Printrove base variant id, e.g.
     *   PRINTROVE_VARIANT_MAP='{"Black|M":123,"Black|L":124}'
     * Required to turn a customer's size/color choice into a printable variant.
     * When provided, the checkout offers exactly these color/size combinations.
     */
    variantMap: jsonMap(process.env.PRINTROVE_VARIANT_MAP),
    /** Retail price for the COD invoice, in your store currency (e.g. INR rupees). */
    retailPrice: num(process.env.PRINTROVE_RETAIL_PRICE, 799),
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
    /** Front-print placement in pixels — tune per product/base blank. */
    print: {
      width: num(process.env.PRINTROVE_PRINT_WIDTH, 3000),
      height: num(process.env.PRINTROVE_PRINT_HEIGHT, 3000),
      top: num(process.env.PRINTROVE_PRINT_TOP, 10),
      left: num(process.env.PRINTROVE_PRINT_LEFT, 50),
    },
  },
} as const;

export type Settings = typeof settings;
