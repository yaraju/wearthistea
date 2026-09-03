import { settings } from "@/config/settings";
import { printifyProvider } from "@/lib/printify";
import { printroveProvider } from "@/lib/printrove";

// ─────────────────────────────────────────────────────────────────────────────
//  Fulfillment provider abstraction
//  One interface, two implementations (Printrove / Printify), selected by the
//  PRINT_PROVIDER env var. Approval calls `fulfill()`; the landing page reads
//  `options()` to build the checkout form.
// ─────────────────────────────────────────────────────────────────────────────

export interface FulfillCustomer {
  name: string;
  email?: string | null;
  phone: string;
  address1: string;
  address2?: string | null;
  address3?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  country: string;
}

export interface FulfillInput {
  /** Unique reference for the order (we use the order id). */
  referenceNumber: string;
  title: string;
  description: string;
  /** Clean, print-ready PNG as base64. */
  designBase64: string;
  designFileName: string;
  /** Configured retail price in cents (Printify variant price). */
  priceCents: number;
  quantity: number;
  variant: { size: string; color: string };
  /**
   * Which supported garment category (men/women/toddler/kids for Printrove)
   * this order is for — selects the product/variant/print-geometry config.
   * Ignored by single-product providers (Printify).
   */
  category: string;
  /** Recipient + shipping. Required by order-placing providers (Printrove). */
  customer: FulfillCustomer | null;
  cod: boolean;
}

export interface FulfillResult {
  productId: string | null;
  orderId: string | null;
  /** Storefront/tracking URL, when the provider exposes one. */
  url: string | null;
  trackingNumber: string | null;
}

export interface VariantOptions {
  provider: string;
  sizes: string[];
  colors: string[];
  countries: string[];
}

export interface PrintProvider {
  name: string;
  /**
   * Size/color/country options offered in the checkout, for the given
   * garment category (ignored by single-product providers like Printify).
   */
  options(category?: string): VariantOptions;
  /** Push an approved selection to the provider (create product, place order…). */
  fulfill(input: FulfillInput): Promise<FulfillResult>;
}

/** The active provider, per `PRINT_PROVIDER` (default: printrove). */
export function getProvider(): PrintProvider {
  return settings.provider === "printify" ? printifyProvider : printroveProvider;
}
