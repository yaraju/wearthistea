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
  batchId: string;
  title: string;
  phrase: string;
  visualConcept: string;
  vibe: string | null;
  blurb: string | null;
  variantColor: string | null; // garment color this art was rendered against
  productImagePath: string;
  designImagePath: string;
  status: string;
  errorMessage: string | null; // generation-failure detail
  // True when designImageData is stored in the DB — safe to retry without the file on disk.
  hasImageData?: boolean;
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
  productImagePath: string;
  designImagePath: string;
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

  createdAt: string;
  updatedAt: string;
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
