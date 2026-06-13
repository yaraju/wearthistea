# wearthistea ☕

**Gossip you can wear.** Type a piece of internet drama → AI brews 5 original
t-shirt design options → you approve one → it's pushed live to Printify.

Phase 1: manual, local, human-in-the-loop. Next.js 16 + React 19 + Tailwind v4 +
Prisma/Postgres + Google Gemini + Printify.

---

## The flow

```
 Landing page (/)                 Admin queue (/admin)
 ┌───────────────────┐            ┌────────────────────────┐
 │ type the "tea"    │            │ pending designs        │
 │   ↓ /api/generate │            │   ↓ Approve & print    │
 │ Gemini writes 5   │            │ /api/admin/approve     │
 │ concepts + images │            │   → Printify upload    │
 │   ↓ pick one      │  ───────►  │   → create product     │
 │ /api/designs/select│  queue    │   → publish live       │
 └───────────────────┘            └────────────────────────┘
```

Each option uses **one paid AI image** — the clean, print-ready design file
(this is what Printify prints). The grid preview is that same file **composited
onto a t-shirt mockup** by `sharp` (free, no extra AI call). So the preview shows
the real print, and a 5-option run costs ~$0.20 instead of ~$0.39.

---

## Setup

### 1. Install

```bash
npm install
```

### 2. Environment

```bash
cp .env.example .env
```

Fill in `.env`:

| Var | Where to get it |
|---|---|
| `DATABASE_URL` | Neon → Connection Details → **Pooled** connection string |
| `GEMINI_API_KEY` | https://aistudio.google.com/apikey (free dev key — *not* the Gemini app subscription) |
| `PRINTROVE_EMAIL` / `PRINTROVE_PASSWORD` | your Printrove merchant login |
| `PRINTROVE_PRODUCT_ID` | base product (blank) id from Printrove's catalog — your "default model" |
| `PRINTROVE_VARIANT_MAP` | JSON mapping `"Color\|Size"` → Printrove variant id (see `.env.example`) |

See [Fulfillment provider](#fulfillment-provider) below to switch to Printify instead.

### 3. Database

```bash
npm run db:push      # creates the Batch + Design tables in Neon
```

### 4. Run

```bash
npm run dev          # http://localhost:3000  (landing)
                     # http://localhost:3000/admin  (approval queue)
```

---

## Where to tune things

Everything you'll iterate on lives in **`src/config/`** — no app logic in there:

- **`src/config/prompts.ts`** — the prompt playbook. Reword the concept writer,
  the artwork prompt, and the product-shot prompt freely. Re-run a keyword to see
  the effect. This is your main knob room.
- **`src/config/settings.ts`** — options per keyword (5), model names, image
  toggles, and Printify blank/price/markup. Most values also read from `.env`.

**Pricing / markup:** set `PRINTIFY_PRICE_CENTS` (or `settings.printify.priceCents`).
It's the retail price applied to every variant — your margin lever over Printify's base cost.

**Models:** defaults are `gemini-2.5-flash` (text) and `gemini-2.5-flash-image`
(images, "Nano Banana" family). Override via `GEMINI_TEXT_MODEL` /
`GEMINI_IMAGE_MODEL`. Point the image var at an `imagen-*` model and the code
auto-switches to the Images API.

---

## Fulfillment provider

The print/fulfillment backend is pluggable behind one interface
(`src/lib/print-provider.ts`), selected by `PRINT_PROVIDER`:

- **`printrove`** (default) — a fulfillment backend (no storefront). When a
  visitor picks a design they fill in size/color + shipping details (international
  address). On **admin approval**, the app uploads the design, creates the
  Printrove product, and places a **Cash-on-Delivery order**. Set
  `PRINTROVE_EMAIL` / `PRINTROVE_PASSWORD`, `PRINTROVE_PRODUCT_ID`, and
  `PRINTROVE_VARIANT_MAP` (maps `"Color|Size"` → Printrove variant id).
- **`printify`** — the original storefront model. On approval the app creates
  and publishes a product to your connected sales channel (no shipping order;
  customer/address fields are ignored). Set `PRINTIFY_API_TOKEN` /
  `PRINTIFY_SHOP_ID`.

Switch anytime by changing `PRINT_PROVIDER` — no code change. All knobs live in
`src/config/settings.ts` (`printrove` / `printify` blocks).

> **Note:** Printrove's API docs don't publish response shapes, so a few fields
> (the design/product/order id keys, created-variant id, and the exact front
> print dimensions) are parsed defensively and may need a small tweak after your
> first live order. Variant resolution uses `PRINTROVE_VARIANT_MAP`.

## Project map

```
src/
  app/
    page.tsx                  landing page (marketing + keyword studio)
    admin/page.tsx            approval queue
    api/
      generate/route.ts       keyword → concepts → images → batch
      designs/select/route.ts pick a design → enters the queue
      admin/batches/route.ts  queue feed
      admin/approve/route.ts  approve → Printify create + publish
      admin/reject/route.ts   reject
  components/KeywordStudio.tsx the interactive hero (input + results grid)
  config/                     ← prompts + settings (edit these)
  lib/
    gemini.ts                 concept + image generation
    printify.ts               catalog resolve, upload, create, publish
    storage.ts                saves artwork under /public/generated
    prisma.ts                 db client
prisma/schema.prisma          Batch + Design models
```

Generated artwork is written to `public/generated/<batchId>/` (git-ignored).

---

## Deploy to Railway

The app runs as a long-lived Node server (`next start`) — Railway-ready out of
the box via `railway.json` (Railpack build, `prisma db push` before each deploy,
health check at `/api/health`).

1. **Create the service** — New Project → *Deploy from GitHub repo* (or
   `railway up` from the CLI). Railpack auto-detects Next.js and runs
   `npm run build`.

2. **Add a Volume for artwork.** The container filesystem is *ephemeral* — files
   written to `public/generated/` vanish on every redeploy, which would break the
   admin queue and Printify uploads. So:
   - Service → **Volumes** → New Volume, mount path `/data`.
   - Set `STORAGE_DIR=/data`. Generated images now persist there and are served
     by the `/generated/[...path]` route handler.

3. **Set environment variables** (Service → Variables):

   | Var | Value |
   |---|---|
   | `DATABASE_URL` | your Neon **pooled** connection string |
   | `GEMINI_API_KEY` | AI Studio key |
   | `PRINTIFY_API_TOKEN` / `PRINTIFY_SHOP_ID` | from Printify |
   | `STORAGE_DIR` | `/data` (the Volume mount above) |
   | `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` | a username + password to gate the site |

   `PORT` is injected by Railway automatically — don't set it.

4. **Deploy.** The `preDeployCommand` runs `prisma db push` to sync the schema to
   Neon, then the server boots. Railway gives you a public URL — open it and
   you'll get a password prompt (the Basic Auth gate).

**Access gate:** with `BASIC_AUTH_*` set, the *entire* deployment sits behind one
password (it's a private Phase-1 tool). This is deliberate — gating only the API
routes would break the landing page's generate button, because browsers don't
show the auth prompt for background `fetch()` calls. Leave the two vars empty to
disable the gate.

**Keeping Neon:** no database migration needed — Railway just points
`DATABASE_URL` at your existing Neon database. (You can swap to Railway Postgres
later by changing that one variable.)

## Notes & guardrails

- Designs are prompted to be **original** and recognizable *by association*
  (line-art, not photo likenesses or copyrighted lyrics). See `ART_RULES` in
  `src/config/prompts.ts`.
- The print-ready file is prompted for a **transparent background**; depending on
  the image model you may want to add a background-removal pass before scaling to
  the full 4500×5400 print spec. (Hook point: `src/lib/gemini.ts`.)
- Admin has **no auth** in Phase 1 (local only), per the project plan.
