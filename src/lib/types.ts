// A saved shipping address on a signed-in customer's account.
export interface AddressDTO {
  id: string;
  label: string | null;
  name: string;
  phone: string;
  address1: string;
  address2: string | null;
  address3: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  country: string;
  isDefault: boolean;
}

// Shape of a Design as returned by the API to the client. Purely creative/
// generation content — order/purchase details live on OrderDTO instead.
export interface DesignDTO {
  id: string;
  // Shareable /design/[slug] identity — set once at creation in
  // /api/generate (a raw-SQL write, since it's an Unsupported-adjacent
  // write path — see embeddings.ts). Null only for pre-migration rows
  // awaiting scripts/backfill-designs.ts, or if that write failed.
  slug?: string | null;
  batchId: string;
  title: string;
  phrase: string;
  visualConcept: string;
  vibe: string | null;
  blurb: string | null;
  backPhrase: string | null; // cheeky back-of-shirt payoff line
  backLayout: string; // "upper-back" | "full-panel" | "chest-height" — A/B/C variant
  variantColor: string | null; // garment color this art was rendered against
  // Screen-quality previews — every customer-facing view renders these.
  productPreviewImagePath: string;
  designPreviewImagePath: string;
  backDesignPreviewImagePath: string | null;
  // Full-res print files are never sent to a customer-facing caller (see
  // /api/generate/retry) — optional/absent there, present only for the
  // brief window before rendering when the initial stub row is empty.
  productImagePath?: string;
  designImagePath?: string;
  status: string;
  errorMessage: string | null; // generation-failure detail
  // True when designImageData is stored in the DB — safe to retry without the file on disk.
  hasImageData?: boolean;
  // LLM-as-judge validation lifecycle (issue #11) — one of
  // src/lib/validation-status.ts's VALIDATION_STATUSES. Optional/loosely
  // typed `string` (not that literal union) so this DTO stays satisfied by
  // any Prisma Design row, including ones from before this field existed;
  // absent should be treated the same as "unjudged" (no badge, not in
  // flight — see isValidationInFlight()).
  validationStatus?: string;
}

// One entry in a Design's version-chain lineage (issue #20) — admin-only
// display, produced by src/lib/design-versions.ts's getDesignVersionChain().
// Deliberately lean (no full-res paths, no prompts) since this only ever
// renders as a small "other versions" banner, never a purchase surface.
export interface DesignVersionSummary {
  id: string;
  slug: string | null;
  title: string;
  validationStatus: string;
  isLatest: boolean;
  isRequested: boolean;
  productPreviewImagePath: string;
  designPreviewImagePath: string;
}

// Shape of an Order (one purchase of a Design) as returned to the admin
// queue, with the parent Design's creative fields flattened in for display.
export interface OrderDTO {
  id: string;
  designId: string;
  status: string;

  title: string;
  phrase: string;
  vibe: string | null;
  // Screen-quality previews — every view renders these.
  productPreviewImagePath: string | null;
  designPreviewImagePath: string | null;
  // Full-res print files — present on the admin queue's usage of this type
  // (for print-quality review), absent on GET /api/account/orders (never
  // sent to a customer-facing caller).
  productImagePath?: string | null;
  designImagePath?: string | null;
  hasImageData?: boolean;
  // The real Printrove mockup for this order's (design, category, color)
  // combo, when its DesignProduct has one ready — preferred over the
  // generic composite above when present.
  printroveMockupUrl: string | null;
  batch: { keyword: string; createdAt: string };

  productCategory: string;
  variantSize: string | null;
  variantColor: string | null;
  quantity: number;
  cod: boolean;
  paymentProvider: string;
  paymentStatus: string;

  recipientName: string | null;
  recipientEmail: string | null;
  recipientPhone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  addressLine3: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  country: string | null;

  unitPriceCents: number | null;
  printroveProductId: string | null;
  printroveUrl: string | null;
  printroveOrderId: string | null;
  trackingNumber: string | null;
  errorMessage: string | null;

  // ── Version-chain awareness (issue #20), admin queue only — a plain read
  // of Design.validationStatus/slug, never resolveLatestDesignVersion(): an
  // Order always displays the EXACT Design it references, this is only a
  // "heads up, a newer version exists" flag + link, never a substitution. ──
  designSlug?: string | null;
  designValidationStatus?: string;

  createdAt: string;
  updatedAt: string;

  // ── Customer-facing fields, populated only by GET /api/account/orders —
  // undefined on the admin queue's usage of this same type. ──────────────
  /** One of: in_review | printing | dispatched | out_for_delivery |
   *  delivered | rejected | failed | cancelled — see order-status.ts. */
  simplifiedStatus?: string;
  /** Clickable tracking link, only when Printrove's live response included
   *  one — a bare tracking number with no URL is shown as plain text
   *  instead of guessing a courier. */
  trackingUrl?: string | null;
  courierName?: string | null;
  deliveredAt?: string | null;
  /** True for a rejected order that hasn't already been regenerated once. */
  canRegenerate?: boolean;
  /** Set once this rejected order has been regenerated — the id of the new
   *  order it spawned. */
  regeneratedIntoOrderId?: string | null;
}

// Checkout options the landing page uses to build the order form.
export interface VariantOptionsDTO {
  provider: string;
  sizes: string[];
  colors: string[];
  countries: string[];
}

export interface GenerateResponse {
  batchId: string;
  keyword: string;
  designs: DesignDTO[];
  options: VariantOptionsDTO;
}

// One purchasable apparel type — the customer's pick-time choice, not a
// brew-time one (see the plan doc: category moved from generation-time to
// selection-time). `category` is the key printroveProduct()/the select and
// design-product APIs expect ("men", "women", ...), not a numeric id.
export interface CatalogCategoryOption {
  category: string;
  label: string;
  sizes: string[];
}

export interface CatalogResponse {
  categories: CatalogCategoryOption[];
  colors: string[];
}

// One semantic-search match — pre-brewed matches on the brew page, and
// "similar designs" on the account page. reviewBadge tells the customer
// whether this design's best combo has cleared admin review yet; it's
// informational only, never a purchase gate (DesignProduct.approvalStatus
// already gates fulfillment — see design-product-review.ts).
export interface DesignMatchDTO {
  id: string;
  slug: string | null;
  title: string;
  phrase: string;
  blurb: string | null;
  productPreviewImagePath: string;
  designPreviewImagePath: string;
  variantColor: string | null;
  distance: number;
  reviewBadge: "taste-tested" | "pending-taste-test";
}

// One (design, category) preview — the real Printrove mockup shown in the
// pick-time/admin-review modal. mockup* stay null while status is "pending"
// (Printrove renders it asynchronously) or "failed".
export interface DesignProductDTO {
  status: string;
  category: string;
  color: string;
  mockupFrontUrl: string | null;
  mockupBackUrl: string | null;
  errorMessage: string | null;
  approvalStatus: string;
}
