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

## Planning & Bug Tracking (GitHub Project)
- All active feature planning and bug tracking happens on the GitHub Project **WearThisTea** (`https://github.com/users/yaraju/projects/1`, project number `1`, owner `yaraju`), backed by issues in `yaraju/wearthistea`. This replaces ad-hoc `.junie/plans/*.md` files as the place *active* planning happens — those existing files are a historical archive only, not a template to keep following.
- `docs/back-design-printrove-verification.md` is a separate, narrower mechanism (an append-only before/after log specifically for PrintRove placement-geometry re-verification) and is **not** replaced or superseded by this workflow — keep using it as-is for that purpose.
- Once a plan is agreed with the user, each well-defined deliverable becomes a GitHub issue (not a markdown checklist), with an explicit validation section in the body split into:
  - `## Validation (automated)` — literal runnable commands (e.g. `npx tsx scripts/test-fulfillment.ts`) that a headless run can execute unattended.
  - `## Validation (manual)` — steps that need a human (e.g. visually confirming a mockup, live PrintRove account checks).
  Add the issue to the project and set its Status to **Ready** (or **Backlog** if explicitly out of scope for the current round).
- Lifecycle: **Ready** → **In progress** (work starts) → **In review** (deliverable complete, awaiting validation) → validated either by a separate headless Claude run or manually by the user → **Done**. Anything that fails validation gets a **new** bug issue filed (linked back to the original), added to the project at Backlog or Ready depending on urgency — the original item still moves to Done once its own validation steps pass.
- At the start of each planning session, review open **Backlog** items for relevance to the work at hand. Call out any that are in-scope; if the user agrees, move them to **Ready** and update them with whatever context is needed to make them actionable now.
- Status field option IDs (re-derive with the command below if they ever change):
  | Status | option-id |
  |---|---|
  | Backlog | `f75ad846` |
  | Ready | `61e4505c` |
  | In progress | `47fc9ee4` |
  | In review | `df73e18b` |
  | Done | `98236657` |
  ```
  # create + file an issue
  gh issue create -R yaraju/wearthistea --title "..." --body "..."

  # add it to the project (prints the project item id)
  gh project item-add 1 --owner "@me" --url <issue-url>

  # set its Status
  gh project item-edit --id <item-id> --project-id PVT_kwHOADBGkM4Bjc-C \
    --field-id PVTSSF_lAHOADBGkM4Bjc-CzhiRNYQ --single-select-option-id <option-id>

  # re-derive field/option ids if they ever change
  gh project field-list 1 --owner "@me" --format json
  ```

## Design Pipeline
- When generating designs, always consider the garment color to ensure high contrast.
- Designs are generated via Gemini API and mockups are created by compositing the design onto a blank tee.
- Support for dynamic catalog selection (category, product type, color) is provided on the landing page.
- Every design also gets a back print (cheeky payoff text + QR code), generated in the same LLM call as the front concept and rendered deterministically — see `src/lib/back-design.ts` and `docs/back-design-printrove-verification.md` for how the PrintRove back-placement wiring was verified live.
