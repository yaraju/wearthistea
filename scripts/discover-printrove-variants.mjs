/**
 * Discover real Printrove product IDs and variant IDs, then write them to .env.
 *
 *   node scripts/discover-printrove-variants.mjs
 *
 * Reads PRINTROVE_EMAIL and PRINTROVE_PASSWORD from .env.
 * Writes PRINTROVE_PRODUCT_ID and PRINTROVE_VARIANT_MAP back to .env when found.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// ── Load .env manually ────────────────────────────────────────────────────────
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(ROOT, ".env");

async function loadEnv() {
  const text = await readFile(envPath, "utf8");
  const vars = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes (single or double).
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // Strip backslash-escaped quotes (common mistake).
    val = val.replace(/\\"/g, '"');
    vars[key] = val;
  }
  return vars;
}

// ── Printrove auth ────────────────────────────────────────────────────────────
const EXT_BASE = "https://api.printrove.com/api/external";
const CAT_BASE = "https://api.printrove.com/api";

async function getToken(email, password) {
  const res = await fetch(`${EXT_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  if (!data.access_token) throw new Error("No access_token in response");
  return data.access_token;
}

async function authGet(token, url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function pubGet(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${await res.text()}`);
  return res.json();
}

// ── .env updater ──────────────────────────────────────────────────────────────
async function updateEnv(updates) {
  let text = await readFile(envPath, "utf8");
  for (const [key, value] of Object.entries(updates)) {
    const escaped = value.replace(/\\/g, "\\\\");
    const line = `${key}='${value}'`;
    const re = new RegExp(`^#?\\s*${key}=.*$`, "m");
    if (re.test(text)) {
      text = text.replace(re, line);
    } else {
      text += `\n${line}`;
    }
  }
  await writeFile(envPath, text, "utf8");
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const env = await loadEnv();
  const { PRINTROVE_EMAIL: email, PRINTROVE_PASSWORD: password } = env;
  if (!email || !password)
    throw new Error("PRINTROVE_EMAIL / PRINTROVE_PASSWORD not set in .env");

  console.log(`\nAuthenticating as ${email}…`);
  const token = await getToken(email, password);
  console.log("  ✓ Token obtained\n");

  // ── 1. Categories ────────────────────────────────────────────────────────
  console.log("Fetching categories…");
  const catData = await authGet(token, `${CAT_BASE}/categories`);
  const categories = catData.data ?? catData;
  for (const c of categories) console.log(`  [${c.id}] ${c.name}`);

  // ── 2. Products for Men's Clothing (cat 25) ──────────────────────────────
  const TARGET_CATEGORY = 25;
  console.log(`\nFetching products for category ${TARGET_CATEGORY} (Men's Clothing)…`);
  const allProducts = await authGet(token, `${CAT_BASE}/category/${TARGET_CATEGORY}/products`);
  const parents = allProducts.filter(p => p.is_parent && p.is_active);
  console.log(`  ${parents.length} active parent products found:`);
  for (const p of parents) console.log(`    [${p.id}] ${p.name}`);

  // ── 3. Find child/variant products ──────────────────────────────────────
  // Children have is_parent=false and parent_id = the parent's id.
  const children = allProducts.filter(p => !p.is_parent && p.parent_id > 0);
  console.log(`\n  ${children.length} child (variant) products found in this category.`);

  // If children are in the list, extract Color|Size mapping directly.
  let variantMap = {};
  let chosenProductId = null;

  if (children.length > 0) {
    // Group children by parent.
    const byParent = {};
    for (const c of children) {
      (byParent[c.parent_id] ??= []).push(c);
    }
    console.log("\n  Children grouped by parent:");
    for (const [parentId, kids] of Object.entries(byParent)) {
      const parentName = parents.find(p => p.id === Number(parentId))?.name ?? "?";
      console.log(`\n    Parent [${parentId}] ${parentName}:`);
      for (const k of kids) {
        const color = k.color ?? k.variant_color ?? k.attributes?.Color ?? "?";
        const size  = k.size  ?? k.variant_size  ?? k.attributes?.Size  ?? "?";
        console.log(`      [${k.id}] color=${color} size=${size} name="${k.name}"`);
      }
    }
  } else {
    console.log("\n  No children in category listing — trying authenticated product detail endpoint…");

    // Try each active parent product to find one with variants.
    for (const parent of parents) {
      let detail;
      try {
        detail = await authGet(token, `${EXT_BASE}/products/${parent.id}`);
      } catch (e) {
        console.log(`    [${parent.id}] ${parent.name} — detail fetch failed: ${e.message}`);
        continue;
      }

      // Normalise: sometimes wrapped in { data: ... } or { product: ... }
      const product = detail.data ?? detail.product ?? detail;
      const variants = product.product_variants ?? product.variants ?? [];
      if (variants.length > 0) {
        console.log(`\n  Found ${variants.length} variants on [${parent.id}] ${parent.name}:`);
        for (const v of variants) {
          console.log("   ", JSON.stringify(v));
        }
      } else {
        console.log(`    [${parent.id}] ${parent.name} — 0 variants in detail response`);
      }
    }
  }

  // ── 4. Try authenticated listing of ALL products (may include children) ──
  console.log("\n  Trying authenticated /products list (may reveal child products)…");
  let authProducts;
  try {
    authProducts = await authGet(token, `${EXT_BASE}/products`);
    const items = authProducts.data ?? authProducts.products ?? authProducts;
    const authChildren = Array.isArray(items)
      ? items.filter(p => !p.is_parent && p.parent_id > 0)
      : [];

    if (authChildren.length > 0) {
      console.log(`  ${authChildren.length} child products via authenticated listing:`);
      const tshirtParent = parents.find(p =>
        p.name.toLowerCase().includes("half sleeve round neck") ||
        p.name.toLowerCase().includes("t-shirt")
      );
      const targetParentId = tshirtParent?.id;

      for (const c of authChildren) {
        const color = c.color ?? c.variant_color ?? c.attributes?.Color ?? "?";
        const size  = c.size  ?? c.variant_size  ?? c.attributes?.Size  ?? "?";
        if (!targetParentId || c.parent_id === targetParentId) {
          console.log(`    [${c.id}] parent=${c.parent_id} color=${color} size=${size} name="${c.name}"`);
          if (color !== "?" && size !== "?") {
            variantMap[`${color}|${size}`] = c.id;
            chosenProductId = c.parent_id;
          }
        }
      }
    } else {
      console.log("  No child products in authenticated listing either.");
      console.log("  Raw sample:", JSON.stringify(Array.isArray(items) ? items[0] : items, null, 2).slice(0, 800));
    }
  } catch (e) {
    console.log(`  Authenticated /products failed: ${e.message}`);
  }

  // ── 5. Summary & .env update ─────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════");
  if (chosenProductId && Object.keys(variantMap).length > 0) {
    console.log(`\n✓ Found ${Object.keys(variantMap).length} variants for product ${chosenProductId}`);
    console.log(`  PRINTROVE_PRODUCT_ID=${chosenProductId}`);
    console.log(`  PRINTROVE_VARIANT_MAP=${JSON.stringify(variantMap)}`);

    await updateEnv({
      PRINTROVE_PRODUCT_ID: String(chosenProductId),
      PRINTROVE_VARIANT_MAP: JSON.stringify(variantMap),
    });
    console.log("\n✓ .env updated.");
  } else {
    console.log("\n⚠ Could not automatically determine variant IDs.");
    console.log("  Review the output above — look for child product IDs and their color/size.");
    console.log("  Then set PRINTROVE_PRODUCT_ID and PRINTROVE_VARIANT_MAP manually.");
  }
}

main().catch(e => { console.error("\n✗", e.message); process.exit(1); });
