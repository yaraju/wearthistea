import { settings } from "@/config/settings";
import type {
  FulfillInput,
  FulfillResult,
  PrintProvider,
  VariantOptions,
} from "@/lib/print-provider";

const BASE = "https://api.printify.com/v1";

function token(): string {
  const t = process.env.PRINTIFY_API_TOKEN;
  if (!t)
    throw new Error(
      "PRINTIFY_API_TOKEN is missing. Create one at Printify → Settings → Connections."
    );
  return t;
}

function shopId(): string {
  const s = process.env.PRINTIFY_SHOP_ID;
  if (!s)
    throw new Error(
      "PRINTIFY_SHOP_ID is missing. Find it via GET /v1/shops.json and add it to .env."
    );
  return s;
}

async function api<T>(
  path: string,
  init?: RequestInit & { json?: unknown }
): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
      "User-Agent": "wearthistea/1.0",
      ...(rest.headers ?? {}),
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Printify ${path} → ${res.status} ${res.statusText} ${detail}`);
  }
  return (await res.json()) as T;
}

// ── Catalog resolution (cached for the process lifetime) ─────────────────────

interface Blueprint {
  id: number;
  title: string;
  brand: string;
  model: string;
}
interface Variant {
  id: number;
  title: string;
  options: Record<string, string>;
}

interface ResolvedBlank {
  blueprintId: number;
  printProviderId: number;
  variantIds: number[];
}

let blankCache: ResolvedBlank | null = null;

/** Find the Bella+Canvas 3001 blueprint, a print provider, and the S–2XL variants. */
export async function resolveBlank(): Promise<ResolvedBlank> {
  if (blankCache) return blankCache;

  const { blueprintQuery, blueprintBrand, sizes, defaultColor } = settings.printify;

  const blueprints = await api<Blueprint[]>("/catalog/blueprints.json");
  const match =
    blueprints.find(
      (b) =>
        (b.model?.includes(blueprintQuery) || b.title?.includes(blueprintQuery)) &&
        b.brand?.toLowerCase().replace(/\s|\+/g, "") ===
          blueprintBrand.toLowerCase().replace(/\s|\+/g, "")
    ) ??
    blueprints.find(
      (b) => b.model?.includes(blueprintQuery) || b.title?.includes(blueprintQuery)
    );

  if (!match)
    throw new Error(
      `No Printify blueprint matched "${blueprintBrand} ${blueprintQuery}". ` +
        `Adjust PRINTIFY_BLUEPRINT_QUERY / _BRAND in settings.`
    );

  const providers = await api<{ id: number; title: string }[]>(
    `/catalog/blueprints/${match.id}/print_providers.json`
  );
  if (!providers.length)
    throw new Error(`Blueprint ${match.id} has no print providers.`);
  const providerId = providers[0].id;

  const variantData = await api<{ variants: Variant[] }>(
    `/catalog/blueprints/${match.id}/print_providers/${providerId}/variants.json`
  );

  const wantSizes = sizes.map((s) => s.toUpperCase());
  const wantColor = defaultColor.toLowerCase();

  const variantIds = variantData.variants
    .filter((v) => {
      const opts = Object.values(v.options ?? {}).map((o) => String(o));
      const title = v.title.toLowerCase();
      const sizeOk = wantSizes.some(
        (s) =>
          opts.some((o) => o.toUpperCase() === s) ||
          new RegExp(`(^|[\\s/])${s}([\\s/]|$)`, "i").test(v.title)
      );
      const colorOk = title.includes(wantColor) || opts.some((o) => o.toLowerCase() === wantColor);
      return sizeOk && colorOk;
    })
    .map((v) => v.id);

  if (variantIds.length === 0)
    throw new Error(
      `No variants matched color="${defaultColor}" sizes=${sizes.join(",")} ` +
        `for blueprint ${match.id}/provider ${providerId}. Check PRINTIFY_DEFAULT_COLOR / _SIZES.`
    );

  blankCache = { blueprintId: match.id, printProviderId: providerId, variantIds };
  return blankCache;
}

// ── Product pipeline ─────────────────────────────────────────────────────────

/** Upload a base64 PNG to Printify's media library; returns the upload id. */
async function uploadImage(fileName: string, base64: string): Promise<string> {
  const res = await api<{ id: string }>("/uploads/images.json", {
    method: "POST",
    json: { file_name: fileName, contents: base64 },
  });
  return res.id;
}

export interface PublishResult {
  productId: string;
  url: string | null;
}

/**
 * Full create-and-(optionally)-publish pipeline for one approved design.
 *   1. upload the clean print file
 *   2. create the product with S–2XL variants + front print placement
 *   3. publish to the connected sales channel (if enabled)
 */
export async function createAndPublish(opts: {
  title: string;
  description: string;
  designBase64: string;
  priceCents: number;
}): Promise<PublishResult> {
  const { blueprintId, printProviderId, variantIds } = await resolveBlank();
  const sid = shopId();

  const imageId = await uploadImage(`${slug(opts.title)}.png`, opts.designBase64);

  const product = await api<{ id: string }>(`/shops/${sid}/products.json`, {
    method: "POST",
    json: {
      title: opts.title,
      description: opts.description,
      blueprint_id: blueprintId,
      print_provider_id: printProviderId,
      variants: variantIds.map((id) => ({
        id,
        price: opts.priceCents,
        is_enabled: true,
      })),
      print_areas: [
        {
          variant_ids: variantIds,
          placeholders: [
            {
              position: "front",
              images: [{ id: imageId, x: 0.5, y: 0.5, scale: 1, angle: 0 }],
            },
          ],
        },
      ],
    },
  });

  let url: string | null = null;
  if (settings.printify.publish) {
    await api(`/shops/${sid}/products/${product.id}/publish.json`, {
      method: "POST",
      json: {
        title: true,
        description: true,
        images: true,
        variants: true,
        tags: true,
      },
    });
    // Best-effort: read back the external storefront handle once published.
    const detail = await api<{ external?: { handle?: string } }>(
      `/shops/${sid}/products/${product.id}.json`
    ).catch(() => null);
    url = detail?.external?.handle ?? null;
  }

  return { productId: product.id, url };
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 50) || "wearthistea-design";
}

// ── Provider interface ───────────────────────────────────────────────────────
// Printify is a storefront/marketplace model: it creates and publishes a
// product. It does not place a shipping order, so customer/address details are
// ignored and no orderId/tracking is returned.
function options(): VariantOptions {
  return {
    provider: "printify",
    sizes: [...settings.printify.sizes],
    colors: [settings.printify.defaultColor],
    countries: [...settings.printrove.countries],
  };
}

async function fulfill(input: FulfillInput): Promise<FulfillResult> {
  const { productId, url } = await createAndPublish({
    title: input.title,
    description: input.description,
    designBase64: input.designBase64,
    priceCents: input.priceCents,
  });
  return { productId, orderId: null, url, trackingNumber: null, printroveDesignId: null };
}

export const printifyProvider: PrintProvider = { name: "printify", options, fulfill };
