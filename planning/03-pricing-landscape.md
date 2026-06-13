# wearthistea — Pricing Landscape (Stage 03)

**Research date:** 2026-06-14 · **Depth:** Quick · Companion to `03-competitive-analysis.md`

> Prices verified 2026-06-14 and change frequently (marketplaces run near-daily sales). Re-verify before Stage 04 price decisions. Labels: `[verified]` / `[company claim]` / `[third-party estimate]` / `[inference]`.

## Per-competitor pricing detail

### Jeff The Brotherhood ("Trending Gifts") — direct
- **Public pricing:** yes. Model: fixed per-item retail with frequent "sale" anchor. `[verified]`
- **Price points:** example tee **$29.99**, sale **$21.99**. `[verified — product pages]`
- **Shipping:** US **$9** first item + **$2** each additional; international **$11** + **$2**. Processing 1–2 business days + 2–7 transit; "fast" 2–3 days. `[verified — shipping policy]`
- **Free trial/freemium:** n/a (retail brand). **Hidden costs:** shipping is not free → effective entry ~$31+ for one tee. `[inference]`
- **Value perception:** **Not publicly available** (no independent reviews surfaced).

### RushOrderTees — AI Generator — direct (mechanic)
- **Public pricing:** **partial** — AI *design* is free, no signup; **per-shirt/print pricing not shown** on the AI page (bulk/custom printer, quote/checkout-based). `[verified]`
- **Model:** free design funnel into a custom/bulk printing order (volume discounts typical of group printers). `[inference]`
- **Hidden costs:** likely minimums/setup for low quantities (typical of bulk printers) — **unverified**.
- **Value perception:** positioned on ease ("if you can type, you can create"). `[company claim]`

### TeePublic — indirect (marketplace)
- **Public pricing:** yes. Tee **$24 list / $15 sale**; long-sleeve **$24 / $17**. `[verified — TeePublic catalog]`
- **Model:** marketplace; near-daily sitewide sales; artist earns flat **~$4/tee**. `[third-party estimate]`
- **Free trial/freemium:** free to browse; free for artists to list. **Discounts:** frequent sitewide. `[third-party estimate]`
- **Value perception:** good price + selection; complaints tie to shared Redbubble fulfillment (see gap analysis). `[customer opinion]`

### Redbubble — indirect (marketplace)
- **Public pricing:** yes; varies by artist markup, roughly **$20–28** list for standard tees. `[company claim / inference]`
- **Model:** marketplace; artist sets markup (~10–20%); base price + markup. `[third-party estimate]`
- **Value perception:** mixed-to-poor on quality/shipping/CS despite competitive price (see gap analysis). `[customer opinion]`

### Kittl — enabler (AI design tool, not a tee seller)
- **Public pricing:** yes. **Free**; **Pro $15/mo** ($10/mo billed annually ≈ $120/yr); **Expert $30/mo** ($24/mo annually ≈ $288/yr); Business/Plus quote-based. `[verified]`
- **Catch:** Free plan exports capped at 800px / 72 DPI (unusable for print) → upsell to paid for print-ready files. `[verified]`
- **Relevance:** sets the cost of the *design* step to ~$10–15/mo unlimited for anyone — i.e., the AI-generation input is cheap and commoditized. `[inference]`

## Cross-competitor pricing comparison

| Competitor | Model | Entry price | Mid / typical | Premium / enterprise | Free trial / freemium | Discounts | What customers complain about | What we can do differently |
|---|---|---|---|---|---|---|---|---|
| **Jeff The Brotherhood** | Fixed retail + sale anchor | ~$21.99 (sale) | $29.99 list | n/a | No | Sale anchors | (no independent reviews) `[gap]` | Sharper niche + real brand + visible trust |
| **RushOrderTees AI** | Free design → custom/bulk print | Design $0 | Per-shirt **not shown** | Bulk/quote | Yes (design) | Pricing opacity `[inference]` | Curation, voice, Gen-Z one-off drops |
| **TeePublic** | Marketplace + daily sales | $15 (sale) | $24 list | n/a | Browse free | Near-daily | Quality/shipping (shared w/ Redbubble) | Curated + personal vs generic search |
| **Redbubble** | Marketplace, artist markup | ~$20 | ~$22–28 | n/a | Browse free | Frequent | Print quality, shipping, bot support | Premium blank + human-checked + speed |
| **Kittl** (tool) | SaaS subscription | Free (capped) | $15/mo Pro | $30/mo Expert; Business quote | Yes | 800px free cap | We sell *finished, curated drops*, not a tool |
| **wearthistea (planned)** | D2C made-on-demand | ~$29.99 | $29.99 | (limited drops) | n/a | Drop/scarcity | TBD | Niche + voice + personalization + trust |

## Pricing read & recommendation `[inference]`
- **Market band:** topical graphic tees sit roughly **$22–30 list**, with marketplaces discounting to **$15–18**. Direct reactive brand (Jeff) lists **$29.99**.
- **Our $29.99 is at the top of the band** — defensible **only** if the brand, timeliness, originality, and quality premium are real and visible. Do **not** chase marketplace sale prices ($15); that's a losing game against $4-margin artist supply.
- **Recommendation:** hold **$26–30** with **"limited drop / only-yours"** scarcity framing; make shipping/threshold transparent (free shipping over $X reads better than Jeff's $9 add-on). Revisit precise tiers in Stage 04 against Printify base cost (set via `PRINTIFY_PRICE_CENTS`).
- **Margin note:** at $29.99 retail on a Bella+Canvas 3001 DTG via Printify, confirm landed unit cost (blank + print + Printify fee) and target ≥ 45–55% gross before shipping. Exact base cost = **resolve in Stage 04** (not invented here).

> Re-verify all prices before `04-price-strategy`. Sources listed in `03-competitive-analysis.md` §13.
