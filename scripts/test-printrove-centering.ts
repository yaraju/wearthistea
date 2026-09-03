import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import { getProductWithVariants } from "../src/lib/printrove";

// ── Minimal standalone Printrove client (mirrors src/lib/printrove.ts internals,
//    duplicated here so this script can pass arbitrary design.dimensions per call
//    instead of the single global PRINTROVE_PRINT_* env values). ──────────────
const BASE = "https://api.printrove.com/api/external";
const SCRATCH =
  process.env.SCRATCH_DIR ||
  "C:\\Users\\Amanda\\AppData\\Local\\Temp\\claude\\C--Users-Amanda-Documents-GitHub-wearthistea\\2f9aa946-a6b8-4977-b4da-9e8b444463a0\\scratchpad";

async function getToken(): Promise<string> {
  const email = process.env.PRINTROVE_EMAIL;
  const password = process.env.PRINTROVE_PASSWORD;
  if (!email || !password) throw new Error("PRINTROVE_EMAIL / PRINTROVE_PASSWORD missing");
  const res = await fetch(`${BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`auth failed ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  if (!data.access_token) throw new Error(`no access_token in: ${text.slice(0, 300)}`);
  return data.access_token;
}

async function api(token: string, path_: string, init: RequestInit & { json?: unknown } = {}) {
  const { json, ...rest } = init;
  const res = await fetch(`${BASE}${path_}`, {
    ...rest,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(rest.headers ?? {}),
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`${path_} -> ${res.status}: ${text.slice(0, 800)}`);
  return data;
}

// The "Observer Mascot" design already sitting on Printrove (from the earlier
// manual test in the merchant dashboard) — reuse its id instead of re-uploading.
const DESIGN_ID = 11926372553;
const BASE_PRODUCT_ID = Number(process.env.PRINTROVE_PRODUCT_SUBTYPE_ID) || 460; // Half Sleeve Round Neck T-Shirt
const VARIANT_ID = 270; // "Black M Men Round" child of product 460, per the /sku/878476 dump

interface Dim {
  width: number;
  height: number;
  top: number;
  left: number;
}

async function createTestProduct(token: string, label: string, dim: Dim) {
  const data = await api(token, "/products", {
    method: "POST",
    json: {
      name: `Centering Test ${label} ${Date.now()}`.slice(0, 120),
      product_id: BASE_PRODUCT_ID,
      is_plain: false,
      design: { front: { id: DESIGN_ID, dimensions: dim } },
      variants: [{ product_id: VARIANT_ID }],
    },
  });
  return data;
}

async function getProduct(token: string, id: number) {
  return api(token, `/products/${id}`);
}

async function downloadImage(url: string, outPath: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buf);
}

async function createAndFetchMockup(token: string, label: string, dim: Dim) {
  console.log(`\n=== ${label} ===`, dim);
  const created = await createTestProduct(token, label, dim);
  const productId = created?.product?.id;
  console.log("created product id:", productId);
  if (!productId) {
    console.log("no product id in response:", JSON.stringify(created).slice(0, 500));
    return;
  }

  let mockupUrl: string | undefined;
  for (let i = 0; i < 10 && !mockupUrl; i++) {
    const prod = await getProduct(token, productId);
    if (i === 0) {
      fs.writeFileSync(
        path.join(SCRATCH, `get-product-${label}.json`),
        JSON.stringify(prod, null, 2)
      );
    }
    const variant = prod?.product?.variants?.[0] ?? prod?.data?.variants?.[0];
    mockupUrl = variant?.mockup?.front_mockup;
    if (!mockupUrl) {
      console.log(`  mockup not ready yet (attempt ${i + 1}), waiting 2s...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  if (!mockupUrl) {
    console.log("  gave up waiting for mockup.");
    return;
  }
  const outPath = path.join(SCRATCH, `mockup-${label}.jpg`);
  await downloadImage(mockupUrl, outPath);
  console.log("  mockup:", mockupUrl);
  console.log("  saved:", outPath);
}

async function main() {
  console.log("Getting token...");
  const token = await getToken();
  console.log("OK, token acquired.");
  fs.mkdirSync(SCRATCH, { recursive: true });

  console.log(`\nFetching catalog product ${BASE_PRODUCT_ID} to inspect print-frame fields...`);
  const catalogProduct = await getProductWithVariants(BASE_PRODUCT_ID) as unknown as Record<
    string,
    unknown
  >;
  console.log("front_print_width:", catalogProduct.front_print_width);
  console.log("front_print_height:", catalogProduct.front_print_height);
  console.log("front_canvas_left:", catalogProduct.front_canvas_left);
  console.log("front_canvas_top:", catalogProduct.front_canvas_top);
  console.log("mockup_width:", catalogProduct.mockup_width);
  console.log("mockup_height:", catalogProduct.mockup_height);

  // The design-placement coordinate space observed in the merchant dashboard
  // (frontCropDetails) is 10x the front_print_width/height ("frame").
  const frameWidth = Number(catalogProduct.front_print_width) * 10;
  const frameHeight = Number(catalogProduct.front_print_height) * 10;
  console.log(`Derived frame: ${frameWidth} x ${frameHeight}`);

  const boxWidth = 3000;
  const boxHeight = 3000;
  const centered: Dim = {
    width: boxWidth,
    height: boxHeight,
    left: Math.round((frameWidth - boxWidth) / 2),
    top: Math.round((frameHeight - boxHeight) / 2),
  };

  const candidates: Record<string, Dim> = {
    current_default: { width: 3000, height: 3000, top: 10, left: 50 },
    centered_v1: centered,
  };

  for (const [label, dim] of Object.entries(candidates)) {
    await createAndFetchMockup(token, label, dim);
  }
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
