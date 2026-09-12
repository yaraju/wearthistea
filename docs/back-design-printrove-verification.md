# Back-design PrintRove verification log

Reference doc for the back-of-shirt feature (cheeky payoff text + QR code,
see `src/lib/back-design.ts`). Records what was verified live against
PrintRove's real API when the feature was built, and the throwaway test
products created to verify it. Referenced from `AGENTS.md`.

**Do not delete the PrintRove test products listed below.** They're kept
intentionally as before/after evidence — if you change back-print geometry,
layout fractions, or anything else that affects placement, re-run the
verification steps below, add a new dated entry, and compare the new
mockups against the ones already on record instead of guessing whether a
change actually did what you intended.

## How to re-verify

1. Inspect current catalog geometry for a category:
   ```ts
   import { getProductWithVariants } from "../src/lib/printrove";
   const p = await getProductWithVariants(460); // 460=Men's, 462=Women's, 560=Toddler, 561=Kids
   // check p.front_print_width/height vs p.back_print_width/height
   ```
2. Run `npx tsx scripts/test-fulfillment.ts` (no `--order`) — this exercises
   the real `fulfill()` path end to end (upload front + back, create a
   PrintRove product with both placements) and prints the resulting
   `productId`/`printroveDesignId`/`printroveBackDesignId`.
3. Poll `GET /products/{id}` (see `getProduct()` in `printrove.ts`) until
   `mockup.back_mockup` is populated, then open it — confirm the back print
   actually shows content (not PrintRove's blank default) and looks
   positioned/sized the way the current `backLayout` box math intends.
4. Append a new dated section below with: what changed, the new test
   product id(s), and a one-line comparison against the last entry.

## 2026-09-11 — initial verification (feature build)

### Catalog geometry (`GET /api/product/{id}`)

Confirmed live that **back print geometry equals front's exactly**, for
every category we sell — this is why the implementation reuses
`settings.ts`'s existing `frame` as the back frame too, instead of adding a
separate `backFrame` config value.

| Category | Product ID | print width (front / back) | print height (front / back) | min printing price DTF (front / back) | rate/sq-in DTF (front / back) |
|---|---|---|---|---|---|
| Men's | 460 | 468 / 468 | 588 / 588 | 120 / 120 | 1.5 / 1.5 |
| Women's | 462 | 348 / 348 | 435 / 435 | 120 / 120 | 1.5 / 1.5 |
| Toddler | 560 | 210 / 210 | 234 / 234 | 120 / 120 | 1.5 / 1.5 |
| Kids | 561 | 348 / 348 | 435 / 435 | 120 / 120 | 1.5 / 1.5 |

(`settings.ts`'s `frame.width/height` = `print_width/height * 10` — matches
the already-configured front frame values for all four categories exactly.)

**Pricing caveat, not yet resolved:** `back_minimum_printing_price_dtf` and
`back_rate_per_square_inch_dtf` are identical to the front's for every
category, which strongly suggests PrintRove charges a comparable *additional*
amount for the back placement on top of the front — but this was not
empirically confirmed (would need to compare `business_base_price` on a
real front-only vs. front+back product). `retailPrice` in `settings.ts` was
tuned against front-only cost tiers and has **not** been re-quoted for
two-sided printing. Re-check actual per-unit cost with PrintRove (or
directly compare `business_base_price` between a front-only product and one
of the test products below) before this goes live for real customers.

### `/products` accepts `{ front, back }` in one call — confirmed

Created product **880003** (`design: { front: {...}, back: {...} }`, both
placements reusing pre-existing test design **11926372553** "Observer
Mascot", Men's/Black/M) and confirmed the response's `mockup.back_mockup`
actually rendered the design on the back of the shirt — not PrintRove's
blank-garment default. This is the finding the whole PrintRove wiring in
`printrove.ts`/`design-products.ts`/`fulfillment.ts` depends on.

- front_mockup: `front-6aa408084365e-Black_M_Men_Round.jpg`
- back_mockup: `back-6aa408084365e-Black_M_Men_Round.jpg`
  (both under `s3.ap-south-1.amazonaws.com/dodatafiles/public/mockups/` —
  these URLs may eventually rot; the product id is the durable reference)

### End-to-end `fulfill()` path — confirmed

Ran `npx tsx scripts/test-fulfillment.ts` (no `--order`) against the real
`fulfill()` function in `printrove.ts` (not a scratch script) with a
generated 300x300 test PNG (a 100x100 opaque square on transparent, since a
1x1 pixel is too small for `trimDesign()`'s `.trim()` step):

- Product **880006** created successfully.
- Front design uploaded fresh as PrintRove design id **11926376840**.
- Back design uploaded fresh as PrintRove design id **11926376841**, layout
  `upper-back`.
- Result: `{ productId: "880006", printroveDesignId: "11926376840", printroveBackDesignId: "11926376841" }`.

### A/B/C layout boxes — visually distinct, confirmed

Created two more test products reusing design 11926372553 (front) and
11926376841 (back, the 100x100 red square):

- Product **880008** — `backLayout: "full-panel"` — back print fills most
  of the back panel, visibly much larger than the other two layouts.
- Product **880009** — `backLayout: "chest-height"` — back print sits
  centered, medium-sized, between `upper-back` and `full-panel`.

Compared against the original `upper-back` placement (product 880006, and
the layout math in `back-design.ts`'s `backBoxForLayout` / `printrove.ts`'s
`fitBackDesignToFrame`), all three were confirmed visually distinct on real
PrintRove mockups: `upper-back` (smallest, highest), `chest-height`
(medium, centered), `full-panel` (largest, fills most of the panel). The
box fractions used (65%/35%, 55%/45%, 90%/90% of the frame) are first-pass
values — eyeball future changes against these products, not just the code.

### QR scannability — confirmed

Rendered the actual `renderBackDesignArtwork()` output (phrase "You Weren't
Reading It Anyway", default QR target `https://wearthistea.web.app`) and
decoded it programmatically with `jsQR` — the QR decodes to the exact
expected URL. Confirms the black-on-white-regardless-of-garment-color
approach (see `back-design.ts`'s doc comment) produces a working code, not
just a good-looking one.

### Test products created this session (kept intentionally)

| Product ID | Category | Purpose | Front design id | Back design id | Layout |
|---|---|---|---|---|---|
| 880003 | Men's/Black/M | Confirm `{front, back}` payload accepted | 11926372553 | 11926372553 | n/a (manual dims) |
| 880006 | Men's/Black/M | End-to-end `fulfill()` path via test-fulfillment.ts | 11926376840 | 11926376841 | upper-back |
| 880008 | Men's/Black/M | Layout comparison | 11926372553 | 11926376841 | full-panel |
| 880009 | Men's/Black/M | Layout comparison | 11926372553 | 11926376841 | chest-height |

## 2026-09-12 — back-print ink-color bug fix (not a geometry change)

`renderBackDesignArtwork()` in `back-design.ts` was passing the garment
**color name** (e.g. `"Black"`) straight through as the Satori text `color`
style, instead of resolving it to a contrasting ink color the way the front
art does (`isDarkGarment()` in `gemini.ts`). CSS accepts `"black"` as a
literal color, so this silently rendered black cheeky-text and QR caption on
a black garment — invisible, not just low-contrast. Fixed by computing
`inkColor = isDarkGarment(opts.color || "Black") ? "#ffffff" : "#111111"`
inside `renderBackDesignArtwork()` itself, so both existing callers
(`design-render.ts`, `realize.ts`) get the fix for free without changing
their call sites.

**This did not touch box geometry/layout fractions** (`backBoxForLayout`,
the 65/35, 55/45, 90/90 splits) — no re-verification against the live
catalog (`GET /api/product/{id}`) was needed per the "How to re-verify"
steps above. Verified instead by downloading a re-rendered back-preview PNG
straight from the production GCS bucket and compositing it onto a black
background locally: the payoff line and QR caption render as legible white
text (previously would have rendered black-on-transparent, invisible once
placed on the black garment).

All 20 designs that already had back art at the time were re-rendered in
place with the fix (deterministic Satori + QR compositing, no LLM call) and
their `printroveBackDesignId` cleared so the next PrintRove touch re-uploads
the corrected art instead of reusing the old, wrong-colored asset — see
`scripts/refix-back-designs.ts`.

### Unrelated same-day migration, noted here for context

Separately, 152 designs (all created before the 2026-09-04 GCS migration,
`33c5ec7`) had lost their full-res art entirely — pre-launch test/dev
batches, no live customer orders. Regenerated in place via
`scripts/regenerate-missing-designs.ts` (same `renderDesignArtwork()` path
as `/api/generate/retry`), which also re-renders each design's back print
against the fix above. For the 9 of those that already had a PrintRove
asset or `DesignProduct` mockup, `printroveDesignId`/`printroveBackDesignId`
and the stale `DesignProduct` rows were cleared the same way, so their next
PrintRove touch re-uploads/rebuilds against the new art. First pass: 109/152
succeeded, 43 hit `RESOURCE_EXHAUSTED` (Gemini prepaid credits depleted, not
a rate limit); retried after topping up credits — all 43 succeeded on
retry. Final state confirmed against the real bucket: 0 designs missing
full-res art, 0 missing previews.
