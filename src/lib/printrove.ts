import sharp from "sharp";
import { settings, printroveProduct, type PrintroveProductConfig } from "@/config/settings";
import type {
  FulfillInput,
  FulfillResult,
  PrintProvider,
  VariantOptions,
} from "@/lib/print-provider";

// Printrove REST API. Docs: https://api.printrove.com/docs/
const BASE = "https://api.printrove.com/api/external";

// ── Auth ─────────────────────────────────────────────────────────────────────
// POST /token with merchant email + password → { access_token, expires_at }.
// Cached in-process until shortly before expiry.
let tokenCache: { token: string; expiresAt: number } | null = null;

function creds(): { email: string; password: string } {
  const email = process.env.PRINTROVE_EMAIL;
  const password = process.env.PRINTROVE_PASSWORD;
  if (!email || !password)
    throw new Error(
      "PRINTROVE_EMAIL / PRINTROVE_PASSWORD are missing — add your Printrove merchant login to the env."
    );
  return { email, password };
}

async function getToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 30_000) return tokenCache.token;

  const { email, password } = creds();
  const res = await fetch(`${BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Printrove auth failed → ${res.status} ${res.statusText} ${detail}`);
  }
  const data = (await res.json()) as { access_token?: string; expires_at?: string };
  if (!data.access_token) throw new Error("Printrove auth returned no access_token.");

  const parsed = data.expires_at ? Date.parse(data.expires_at) : NaN;
  tokenCache = {
    token: data.access_token,
    expiresAt: Number.isNaN(parsed) ? Date.now() + 30 * 60_000 : parsed,
  };
  return tokenCache.token;
}

type Json = Record<string, unknown>;

async function api<T = Json>(
  path: string,
  init?: RequestInit & { json?: unknown }
): Promise<T> {
  const token = await getToken();
  const { json, ...rest } = init ?? {};
  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(rest.headers ?? {}),
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Printrove ${path} → ${res.status} ${res.statusText} ${detail}`);
  }
  return (await res.json()) as T;
}

/** Pull a numeric id out of a response that may nest it under a wrapper key. */
function pickId(data: Json, ...keys: string[]): number | null {
  const wrappers = [data, data.data, data.product, data.order, data.design].filter(
    Boolean
  ) as Json[];
  for (const w of wrappers) {
    for (const k of keys) {
      const v = w[k];
      if (v != null && !Number.isNaN(Number(v))) return Number(v);
    }
  }
  return null;
}

// ── Design upload (multipart) ────────────────────────────────────────────────
// Exported: design-products.ts calls this directly (not through fulfill())
// to upload a design's artwork once and reuse the resulting id across every
// (category, color) preview product for that design — see
// Design.printroveDesignId.
export async function uploadDesign(fileName: string, base64: string): Promise<number> {
  const token = await getToken();
  const bytes = Buffer.from(base64, "base64");
  const form = new FormData();

  form.append("file", new Blob([bytes], { type: "image/png" }), fileName);
  form.append("name", fileName.replace(/\.[a-z]+$/i, ""));

  // Note: don't set Content-Type — fetch adds the multipart boundary itself.
  const res = await fetch(`${BASE}/designs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    body: form,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Printrove design upload → ${res.status} ${res.statusText} ${detail}`);
  }
  const data = (await res.json()) as Json;
  const id = pickId(data, "id", "design_id");
  if (id == null)
    throw new Error(
      `Printrove design upload returned no id. Response: ${JSON.stringify(data).slice(0, 300)}`
    );
  return id;
}


// Fit a design's real pixel dimensions inside Printrove's print frame,
// preserving its aspect ratio, and center it — generalizes the centering
// recipe previously hand-applied once per category (see settings.ts) to run
// for every design's actual generated size, since Gemini doesn't reliably
// hit the requested canvas dimensions (see text-layer.ts).
function fitDesignToFrame(
  imgWidth: number,
  imgHeight: number,
  frame: { width: number; height: number }
): { width: number; height: number; top: number; left: number } {
  const scale = Math.min(frame.width / imgWidth, frame.height / imgHeight);
  const width = Math.round(imgWidth * scale);
  const height = Math.round(imgHeight * scale);
  return {
    width,
    height,
    left: Math.round((frame.width - width) / 2),
    top: Math.round((frame.height - height) / 2),
  };
}

/**
 * Trim a base64 PNG's transparent padding down to its tight content
 * bounding box, and return that trimmed image alongside its real pixel
 * size. Printrove auto-trims an uploaded design's transparent padding
 * before compositing it — verified live: a design canvas at 928x1152
 * (ratio 0.806, with generous margins around the art) was stored by
 * Printrove as an 618x976 (ratio 0.633) file once uploaded. Computing
 * fitDesignToFrame() from the UNTRIMMED canvas size against Printrove's
 * TRIMMED content produced a real, visible aspect-ratio mismatch (the
 * fitted box was shaped for the padded canvas, not the actual printed
 * content) — trimming ourselves before upload, and using the trimmed size
 * for every placement calculation (including a design already uploaded
 * under the old untrimmed behavior), keeps the two in sync regardless of
 * whether Printrove's own trim exactly matches ours.
 */
export async function trimDesign(base64: string): Promise<{ base64: string; width: number; height: number }> {
  const { data, info } = await sharp(Buffer.from(base64, "base64")).trim().toBuffer({ resolveWithObject: true });
  return { base64: data.toString("base64"), width: info.width, height: info.height };
}

function frontDesign(designId: number, dimensions: { width: number; height: number; top: number; left: number }) {
  return { front: { id: designId, dimensions } };
}

// ── Create product (adds the design-on-blank to your Product Library) ─────────
// Exported: design-products.ts calls this directly for preview-product
// creation (one per design/category/color, at a fixed previewSize), same as
// fulfill() does for a real order's actual variant.
export async function createProduct(opts: {
  name: string;
  designId: number;
  baseVariantId: number;
  product: PrintroveProductConfig;
  imageSize: { width: number; height: number };
}): Promise<{ productId: number; variantId: number | null }> {
  const dimensions = fitDesignToFrame(opts.imageSize.width, opts.imageSize.height, opts.product.frame);
  const data = await api("/products", {
    method: "POST",
    json: {
      name: opts.name.slice(0, 120),
      product_id: opts.product.subtypeId,
      is_plain: false,
      design: frontDesign(opts.designId, dimensions),
      variants: [{ product_id: opts.baseVariantId }],
    },
  });
  const productId = pickId(data, "id", "product_id");
  if (productId == null)
    throw new Error(
      `Printrove create product returned no id. Response: ${JSON.stringify(data).slice(0, 300)}`
    );

  // Best-effort: the created product's own variant id (used by the order).
  const product = (data.product ?? data.data ?? data) as Json;
  const variants = product.variants as Array<{ id?: number | string }> | undefined;
  const variantId = variants?.[0]?.id != null ? Number(variants[0].id) : null;

  return { productId, variantId };
}

export interface PrintroveMockup {
  front_mockup?: string;
  back_mockup?: string;
  front_mockup_thumbnail?: string;
  back_mockup_thumbnail?: string;
}

/**
 * GET /products/{id} — a just-created product's mockup is null until
 * Printrove finishes rendering it asynchronously (seconds, verified live —
 * not returned synchronously by createProduct). Callers poll this.
 */
export async function getProduct(
  productId: number
): Promise<{ variantId: number | null; mockup: PrintroveMockup | null }> {
  const data = await api(`/products/${productId}`, { method: "GET" });
  const product = (data.product ?? data.data ?? data) as Json;
  const variants = product.variants as
    | Array<{ id?: number | string; mockup?: PrintroveMockup | null }>
    | undefined;
  const variant = variants?.[0];
  const variantId = variant?.id != null ? Number(variant.id) : null;
  return { variantId, mockup: variant?.mockup ?? null };
}

// ── Place order (COD by default) ─────────────────────────────────────────────
async function createOrder(opts: {
  reference: string;
  productId: number;
  variantId: number | null;
  designId: number;
  quantity: number;
  cod: boolean;
  customer: NonNullable<FulfillInput["customer"]>;
  product: PrintroveProductConfig;
  imageSize: { width: number; height: number };
}): Promise<{ orderId: string | null; trackingNumber: string | null }> {
  const c = opts.customer;
  const phoneDigits = String(c.phone).replace(/\D/g, "");

  // order_products: prefer a concrete variant_id; otherwise product_id + design.
  const orderProduct: Json =
    opts.variantId != null
      ? { variant_id: opts.variantId, quantity: opts.quantity }
      : {
          product_id: opts.productId,
          design: frontDesign(
            opts.designId,
            fitDesignToFrame(opts.imageSize.width, opts.imageSize.height, opts.product.frame)
          ),
          quantity: opts.quantity,
        };

  const data = await api("/orders", {
    method: "POST",
    json: {
      reference_number: opts.reference,
      // Still a plain rupee number, not actual paise/cents, despite the
      // Order.unitPriceCents field name it ends up in — same unit the
      // codebase has always used here; a real cents conversion is a
      // pricing/invoicing-phase concern, not a category-config one.
      retail_price: opts.product.retailPrice,
      cod: opts.cod,
      customer: {
        name: c.name,
        ...(c.email ? { email: c.email } : {}),
        number: phoneDigits ? Number(phoneDigits) : phoneDigits,
        address1: c.address1,
        // Omit when blank rather than sending a "-" placeholder — verified
        // live against Printrove's API: it now rejects address2 shorter
        // than 3 characters ("must be between 3 and 55 characters"), so the
        // old placeholder made every order with no address line 2 fail.
        ...(c.address2 ? { address2: c.address2 } : {}),
        ...(c.address3 ? { address3: c.address3 } : {}),
        ...(c.city ? { city: c.city } : {}),
        ...(c.state ? { state: c.state } : {}),
        ...(c.pincode ? { pincode: c.pincode } : {}),
        country: c.country,
      },
      order_products: [orderProduct],
    },
  });

  const orderId = pickId(data, "id", "order_id");
  const order = (data.order ?? data.data ?? data) as Json;
  const tracking =
    (order.tracking_number as string | undefined) ??
    (order.awb as string | undefined) ??
    null;

  return {
    orderId: orderId != null ? String(orderId) : null,
    trackingNumber: tracking ?? null,
  };
}

export interface PrintroveOrderStatus {
  raw: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  courierName: string | null;
  /** Delivery timestamp, if Printrove's response includes one — prefer this
   *  over the moment we happened to observe "delivered" (see
   *  printrove-order-status.ts). */
  deliveredAt: Date | null;
}

/**
 * GET /orders/{id} — live order status, fetched on-demand when a customer
 * opens /account/orders (no webhook — see printrove-order-status.ts). The
 * exact response schema is UNCONFIRMED: Printrove's public docs
 * (https://api.printrove.com/docs/) confirm this endpoint exists but don't
 * document its response fields. The field names below are best-effort
 * guesses pending a real run of scripts/test-order-status.ts against an
 * actual placed order (none existed in this database as of writing this) —
 * correct them here once real output is available; nothing else in the
 * status pipeline should need to change (see printrove-status.ts).
 */
export async function getOrderStatus(printroveOrderId: string): Promise<PrintroveOrderStatus> {
  const data = await api(`/orders/${printroveOrderId}`, { method: "GET" });
  const order = (data.order ?? data.data ?? data) as Json;

  const rawStatus = (order.status as string | undefined) ?? null; // field name GUESSED
  const trackingUrl = (order.tracking_url as string | undefined) ?? null; // GUESSED — may not exist
  const courierName =
    (order.courier as string | undefined) ?? (order.courier_name as string | undefined) ?? null; // GUESSED
  const deliveredRaw =
    (order.delivered_at as string | undefined) ?? (order.delivery_date as string | undefined) ?? null; // GUESSED
  const deliveredAt = deliveredRaw ? new Date(deliveredRaw) : null;

  return {
    raw: rawStatus,
    trackingNumber:
      (order.tracking_number as string | undefined) ?? (order.awb as string | undefined) ?? null,
    trackingUrl,
    courierName,
    deliveredAt: deliveredAt && !Number.isNaN(deliveredAt.getTime()) ? deliveredAt : null,
  };
}

// ── Catalog APIs (public — no auth required) ─────────────────────────────────
const CATALOG_BASE = "https://api.printrove.com/api";


export interface PrintroveCategory {
  id: number;
  name: string;
}

export interface PrintroveProduct {
  id: number;
  name: string;
  category_id: number;
  is_parent: boolean;
  parent_id: number;
  is_active: boolean;
  is_instock: number;
  image_url?: string;
  product_variants?: Array<{ id: number; [k: string]: unknown }>;
  product_attributes?: Array<{ id: number; product_id: number; name: string }>;
  children?: Array<{
    id: number;
    product?: {
      id: number;
      name: string;
      product_attribute_values?: Array<{
        id: number;
        product_attribute_id: number;
        value: string;
        color_code: string;
      }>;
    };
  }>;
}

export interface PrintroveStockItem {
  id: number;
  product_id: number;
  variant_id: number;
  quantity: number;
  availability: string;
  category_id: number;
  color: string;
  size: string;
}

interface PrintroveRawStockItem {
  id: number;
  product_id: number;
  parent_id?: number;
  stock?: number;
  quantity?: number;
  is_instock?: number;
  category_id: number;
  color?: string;
  size?: string;
  product_variants?: Array<{
    product_attribute_id: number;
    value: string;
    name?: string;
  }>;
}

/** GET /api/parent_products — returns all parent products. */
export async function getParentProducts(): Promise<PrintroveProduct[]> {
  const token = await getToken();
  const res = await fetch(`${CATALOG_BASE}/parent_products`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Printrove /parent_products → ${res.status} ${res.statusText}`);
  const data = await res.json() as { data?: PrintroveProduct[] };
  return data.data ?? [];
}

/** GET /api/stock — returns stock availability. */
export async function getStockCount(params: {
  page?: number;
  per_page?: number;
  availability?: string;
  category_id?: number;
} = {}): Promise<PrintroveStockItem[]> {
  const token = await getToken();
  const query = new URLSearchParams();
  if (params.page) query.append("page", params.page.toString());
  if (params.per_page) query.append("per_page", params.per_page.toString());
  if (params.availability) query.append("availability", params.availability);
  if (params.category_id) query.append("category_id", params.category_id.toString());

  const res = await fetch(`${CATALOG_BASE}/stock?${query.toString()}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Printrove /stock → ${res.status} ${res.statusText}`);
  const data = await res.json() as { data?: PrintroveRawStockItem[] };
  
  const results = data.data ?? [];
  return results.map((item) => {
    // Extract color and size from product_variants if they're not directly on the item
    let color = item.color;
    let size = item.size;

    if (item.product_variants) {
      if (!color) {
        const colorAttr = item.product_variants.find(
          (v: any) =>
            v.product_attribute_id === 2 || 
            (v.name && v.name.toLowerCase().includes("color")) ||
            (v.attribute_name && v.attribute_name.toLowerCase().includes("color"))
        );
        color = colorAttr?.value || colorAttr?.name;
      }
      if (!size) {
        const sizeAttr = item.product_variants.find(
          (v: any) =>
            v.product_attribute_id === 1 || 
            (v.name && v.name.toLowerCase().includes("size")) ||
            (v.attribute_name && v.attribute_name.toLowerCase().includes("size"))
        );
        size = sizeAttr?.value || sizeAttr?.name;
      }
    }

    return {
      id: item.id,
      // Printrove stock items often use parent_id for the base product.
      // If missing, product_id might be the base or the variant.
      product_id: item.parent_id || item.product_id,
      variant_id: item.id,
      quantity: item.stock ?? item.quantity ?? 0,
      availability: (item.stock ?? item.quantity ?? 0) > 0 ? "in_stock" : "out_of_stock",
      category_id: item.category_id,
      color: color || "Unknown",
      size: size || "Unknown",
    };
  });
}

/** GET /api/categories — returns all top-level product categories. */
export async function getCategories(): Promise<PrintroveCategory[]> {
  try {
    const token = await getToken();
    const res = await fetch(`${CATALOG_BASE}/categories`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Printrove /categories → ${res.status} ${res.statusText}`);
    const data = await res.json() as { data?: PrintroveCategory[] };
    return data.data ?? [];
  } catch (err) {
    console.error("Error in getCategories:", err);
    throw err;
  }
}

/** GET /api/category/{id}/products — returns all products in a category. */
export async function getProductsByCategory(categoryId: number): Promise<PrintroveProduct[]> {
  const token = await getToken();
  const res = await fetch(`${CATALOG_BASE}/category/${categoryId}/products`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Printrove /category/${categoryId}/products → ${res.status} ${res.statusText}`);
  const data = await res.json() as PrintroveProduct[];
  return Array.isArray(data) ? data : [];
}

/**
 * GET /api/product/{id} — returns a single product with its child
 * variants (colour × size combinations) from the catalog.
 */
export async function getProductWithVariants(productId: number): Promise<PrintroveProduct> {
  const token = await getToken();
  const res = await fetch(`${CATALOG_BASE}/product/${productId}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Printrove /product/${productId} → ${res.status} ${res.statusText}`);
  const data = await res.json() as { data: PrintroveProduct };
  return data.data;
}

/**
 * Resolve a customer's color/size choice to a Printrove base variant id
 * using the API. Attribute ids are assigned per-product by Printrove (not
 * globally — verified live: Men's uses 1=Size/2=Color, Women's 5=Size/6=Color,
 * Toddler 12=Size/11=Color, Kids 14=Size/13=Color), so the caller must pass
 * the specific category's attribute ids rather than assuming 1/2.
 */
async function resolveVariantIdDynamically(
  productId: number,
  color: string,
  size: string,
  sizeAttrId: number,
  colorAttrId: number
): Promise<number> {
  const product = await getProductWithVariants(productId);
  if (!product.children || product.children.length === 0) {
    throw new Error(`Printrove product ${productId} has no variants (children).`);
  }

  for (const child of product.children) {
    const attrs = child.product?.product_attribute_values;
    if (!attrs) continue;

    let matchColor = false;
    let matchSize = false;

    for (const attr of attrs) {
      if (attr.product_attribute_id === sizeAttrId && attr.value.toLowerCase() === size.toLowerCase()) {
        matchSize = true;
      }
      if (attr.product_attribute_id === colorAttrId && attr.value.toLowerCase() === color.toLowerCase()) {
        matchColor = true;
      }
    }

    if (matchColor && matchSize) {
      return child.id;
    }
  }

  throw new Error(`No Printrove variant found for "${color}|${size}" in product ${productId}.`);
}

// ── Provider interface ───────────────────────────────────────────────────────
function options(category?: string): VariantOptions {
  const product = printroveProduct(category);
  const keys = Object.keys(product.variantMap);
  const sizeSet = new Set<string>();
  const colorSet = new Set<string>();
  for (const k of keys) {
    const [color, size] = k.split("|");
    if (color) colorSet.add(color);
    if (size) sizeSet.add(size);
  }

  return {
    provider: "printrove",
    sizes: [...sizeSet],
    colors: [...colorSet],
    countries: [...settings.printrove.countries],
  };
}

export async function fulfill(input: FulfillInput): Promise<FulfillResult> {
  const product = printroveProduct(input.category);

  const baseVariantId = await resolveVariantIdDynamically(
    product.subtypeId,
    input.variant.color,
    input.variant.size,
    product.sizeAttrId,
    product.colorAttrId
  );
  // Reuse the design asset already uploaded at brew time (design-products.ts)
  // when we have it — upload is size/category-agnostic, so there's never a
  // reason to re-upload the same artwork. Still always calls createProduct
  // for THIS variant's actual size — a cached preview product (built at
  // previewSize) is never reused here; see the DesignProduct doc comment.
  const trimmed = await trimDesign(input.designBase64);
  const designId = input.printroveDesignId
    ? Number(input.printroveDesignId)
    : await uploadDesign(input.designFileName, trimmed.base64);
  const imageSize = { width: trimmed.width, height: trimmed.height };
  const { productId, variantId } = await createProduct({
    name: input.title,
    designId,
    baseVariantId,
    product,
    imageSize,
  });

  let orderId: string | null = null;
  let trackingNumber: string | null = null;

  if (input.customer) {
    const res = await createOrder({
      reference: input.referenceNumber,
      productId,
      variantId,
      designId,
      quantity: input.quantity,
      cod: input.cod,
      customer: input.customer,
      product,
      imageSize,
    });
    orderId = res.orderId;
    trackingNumber = res.trackingNumber;
  }

  return { productId: String(productId), orderId, url: null, trackingNumber, printroveDesignId: String(designId) };
}

export const printroveProvider: PrintProvider = { name: "printrove", options, fulfill };
