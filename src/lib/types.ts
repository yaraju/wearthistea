// Shape of a Design as returned by the API to the client.
export interface DesignDTO {
  id: string;
  batchId: string;
  title: string;
  phrase: string;
  visualConcept: string;
  vibe: string | null;
  blurb: string | null;
  productImagePath: string;
  designImagePath: string;
  status: string;
  selected: boolean;

  // Order details (captured when a visitor picks this design).
  variantSize: string | null;
  variantColor: string | null;
  quantity: number;
  cod: boolean;
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

  // Fulfillment results (provider-agnostic).
  priceCents: number | null;
  printifyProductId: string | null;
  printifyUrl: string | null;
  providerOrderId: string | null;
  trackingNumber: string | null;
  errorMessage: string | null;
  // True when designImageData is stored in the DB — safe to retry without the file on disk.
  hasImageData?: boolean;
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
