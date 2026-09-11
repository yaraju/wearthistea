<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Print-on-Demand (POD) Guidelines
- We support multiple providers (Printify, PrintRove) via a common interface in `src/lib/print-provider.ts`.
- PrintRove integration uses dynamic variant lookup via the catalog API (`GET /api/product/{id}`).
- Avoid static variant maps when possible; use `resolveVariantIdDynamically` in `src/lib/printrove.ts`.
- When adding new products/subtypes, update `.env` and `src/config/settings.ts`.
- `PRINTROVE_PRODUCT_ID` is used as the category ID for context.
- `PRINTROVE_PRODUCT_SUBTYPE_ID` is the base product ID (e.g. Round Neck T-Shirt).

## Design Uploads
- Designs must be high-res PNGs with transparent backgrounds.
- Design upload returns a `design_id` which is then used for product creation.
- Product creation in PrintRove account returns a `product_id` and `variant_id` (in the merchant library) which are used for orders.

## Testing
- Use `npx tsx` to run TypeScript scripts in `scripts/`.
- Use `scripts/test-fulfillment.ts` to verify design upload and product creation without placing real orders (by omitting `--order`).
- Always verify design upload and product creation before testing order placement.
- Before changing PrintRove placement geometry (front OR back), re-verify against the live catalog and record it in `docs/back-design-printrove-verification.md` — it's a running before/after log with the throwaway test products left on the PrintRove account for exactly this comparison. Don't delete those test products.

## Design Pipeline
- When generating designs, always consider the garment color to ensure high contrast.
- Designs are generated via Gemini API and mockups are created by compositing the design onto a blank tee.
- Support for dynamic catalog selection (category, product type, color) is provided on the landing page.
- Every design also gets a back print (cheeky payoff text + QR code), generated in the same LLM call as the front concept and rendered deterministically — see `src/lib/back-design.ts` and `docs/back-design-printrove-verification.md` for how the PrintRove back-placement wiring was verified live.
