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
  batch: { keyword: string; createdAt: string };

  productCategory: string;
  variantSize: string | null;
  variantColor: string | null;
  quantity: number;
  cod: boolean;
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

export interface CatalogProduct {
  id: number;
  name: string;
  colors: string[];
}

export interface CatalogCategory {
  id: number;
  name: string;
  products: CatalogProduct[];
}

export interface CatalogResponse {
  categories: CatalogCategory[];
}
