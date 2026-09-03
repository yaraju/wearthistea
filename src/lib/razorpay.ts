import crypto from "node:crypto";
import Razorpay from "razorpay";

let client: Razorpay | null = null;

/** Lazily-instantiated Razorpay client — throws a clear error if the keys
 * aren't configured yet, rather than failing deep inside the SDK. */
export function getRazorpayClient(): Razorpay {
  if (client) return client;
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key_id || !key_secret) {
    throw new Error(
      "RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are missing — add your Razorpay API keys to the env."
    );
  }
  client = new Razorpay({ key_id, key_secret });
  return client;
}

/** Verify a Checkout success callback's signature (order_id|payment_id,
 * HMAC-SHA256 with the key secret) — per Razorpay's documented scheme. Never
 * trust razorpay_payment_id/order_id from the client without this. */
export function verifyPaymentSignature(opts: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  signature: string;
}): boolean {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret) throw new Error("RAZORPAY_KEY_SECRET is missing.");
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${opts.razorpayOrderId}|${opts.razorpayPaymentId}`)
    .digest("hex");
  return timingSafeEqualHex(expected, opts.signature);
}

/** Verify a webhook delivery's `X-Razorpay-Signature` header (HMAC-SHA256 of
 * the raw request body with the webhook secret — a DIFFERENT secret from
 * the API key secret, set separately in the Razorpay dashboard). Must be
 * computed over the raw body text, not a re-serialized/parsed copy of it —
 * JSON.stringify(JSON.parse(body)) is not guaranteed to reproduce the exact
 * bytes Razorpay signed. */
export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) throw new Error("RAZORPAY_WEBHOOK_SECRET is missing.");
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return timingSafeEqualHex(expected, signature);
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
