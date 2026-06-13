import { settings } from "@/config/settings";
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
async function uploadDesign(fileName: string, base64: string): Promise<number> {
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

/** Resolve a customer's color/size choice to a Printrove base variant id. */
function resolveVariantId(color: string, size: string): number {
  const key = `${color}|${size}`;
  const id = settings.printrove.variantMap[key];
  if (!id)
    throw new Error(
      `No Printrove variant mapped for "${key}". Set PRINTROVE_VARIANT_MAP, e.g. {"${key}": 12345}.`
    );
  return id;
}

function frontDesign(designId: number) {
  const p = settings.printrove.print;
  return {
    front: {
      id: designId,
      dimensions: { width: p.width, height: p.height, top: p.top, left: p.left },
    },
  };
}

// ── Create product (adds the design-on-blank to your Product Library) ─────────
async function createProduct(opts: {
  name: string;
  designId: number;
  baseVariantId: number;
}): Promise<{ productId: number; variantId: number | null }> {
  const data = await api("/products", {
    method: "POST",
    json: {
      name: opts.name.slice(0, 120),
      product_id: settings.printrove.productId,
      is_plain: false,
      design: frontDesign(opts.designId),
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

// ── Place order (COD by default) ─────────────────────────────────────────────
async function createOrder(opts: {
  reference: string;
  productId: number;
  variantId: number | null;
  designId: number;
  quantity: number;
  cod: boolean;
  customer: NonNullable<FulfillInput["customer"]>;
}): Promise<{ orderId: string | null; trackingNumber: string | null }> {
  const c = opts.customer;
  const phoneDigits = String(c.phone).replace(/\D/g, "");

  // order_products: prefer a concrete variant_id; otherwise product_id + design.
  const orderProduct: Json =
    opts.variantId != null
      ? { variant_id: opts.variantId, quantity: opts.quantity }
      : {
          product_id: opts.productId,
          design: frontDesign(opts.designId),
          quantity: opts.quantity,
        };

  const data = await api("/orders", {
    method: "POST",
    json: {
      reference_number: opts.reference,
      retail_price: settings.printrove.retailPrice,
      cod: opts.cod,
      customer: {
        name: c.name,
        ...(c.email ? { email: c.email } : {}),
        number: phoneDigits ? Number(phoneDigits) : phoneDigits,
        address1: c.address1,
        address2: c.address2 || "-",
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

// ── Provider interface ───────────────────────────────────────────────────────
function options(): VariantOptions {
  const keys = Object.keys(settings.printrove.variantMap);
  let sizes = [...settings.printrove.sizes];
  let colors = [...settings.printrove.colors];

  // When a variant map is configured, offer exactly those color/size combos.
  if (keys.length) {
    const sizeSet = new Set<string>();
    const colorSet = new Set<string>();
    for (const k of keys) {
      const [color, size] = k.split("|");
      if (color) colorSet.add(color);
      if (size) sizeSet.add(size);
    }
    colors = [...colorSet];
    sizes = [...sizeSet];
  }

  return {
    provider: "printrove",
    sizes,
    colors,
    countries: [...settings.printrove.countries],
  };
}

async function fulfill(input: FulfillInput): Promise<FulfillResult> {
  if (!settings.printrove.productId)
    throw new Error(
      "PRINTROVE_PRODUCT_ID is not set — provide the base product (the blank you print on)."
    );
  if (!input.customer)
    throw new Error("Printrove orders require recipient & shipping details.");

  const baseVariantId = resolveVariantId(input.variant.color, input.variant.size);
  const designId = await uploadDesign(input.designFileName, input.designBase64);
  const { productId, variantId } = await createProduct({
    name: input.title,
    designId,
    baseVariantId,
  });
  const { orderId, trackingNumber } = await createOrder({
    reference: input.referenceNumber,
    productId,
    variantId,
    designId,
    quantity: input.quantity,
    cod: input.cod,
    customer: input.customer,
  });

  return { productId: String(productId), orderId, url: null, trackingNumber };
}

export const printroveProvider: PrintProvider = { name: "printrove", options, fulfill };
