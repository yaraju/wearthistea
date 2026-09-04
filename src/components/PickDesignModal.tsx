"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, ArrowRight, X } from "lucide-react";
import type { DesignDTO, AddressDTO, CatalogCategoryOption } from "@/lib/types";
import CustomerSignIn from "@/components/CustomerSignIn";
import AddAddressForm from "@/components/AddAddressForm";
import DesignProductPreview from "@/components/DesignProductPreview";

const FIELD_CLS =
  "w-full rounded-lg border border-line bg-paper px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-soft/60 focus:border-ink focus:outline-none";

declare global {
  interface Window {
    Razorpay?: new (opts: Record<string, unknown>) => { open: () => void };
  }
}

let razorpayScriptPromise: Promise<void> | null = null;
function loadRazorpayScript(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  if (razorpayScriptPromise) return razorpayScriptPromise;
  razorpayScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load the payment form. Check your connection and try again."));
    document.body.appendChild(script);
  });
  return razorpayScriptPromise;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response shape varies per endpoint, matches the same helper's established typing in KeywordStudio.tsx
async function parseJsonResponse(res: Response): Promise<any> {
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error(res.ok ? "Unexpected response from the server." : `Server error (${res.status}). Please try again in a moment.`);
  }
  return res.json();
}

/**
 * Replaces the old inline checkout form: apparel-type dropdown, real
 * Printrove preview (DesignProductPreview), saved-address snippet/switcher/
 * add-another, size/qty/payment, submit. Sign-in (Google or email-link) is
 * required before shipping — checkout is how an account gets created now.
 */
export default function PickDesignModal({
  design,
  onClose,
  onPlaced,
}: {
  design: DesignDTO;
  onClose: () => void;
  onPlaced: () => void;
}) {
  const [categories, setCategories] = useState<CatalogCategoryOption[] | null>(null);
  const [needsShipping, setNeedsShipping] = useState(true);
  const [category, setCategory] = useState("");
  const [size, setSize] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [paymentMethod, setPaymentMethod] = useState<"prepaid" | "cod">("prepaid");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [me, setMe] = useState<{ signedIn: boolean; email: string | null } | null>(null);
  const [addresses, setAddresses] = useState<AddressDTO[] | null>(null);
  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);
  const [addingAddress, setAddingAddress] = useState(false);

  const brewedImg = design.designImagePath || design.productImagePath;
  const selectedCategory = categories?.find((c) => c.category === category) ?? null;

  const loadAddresses = useCallback(async () => {
    const res = await fetch("/api/account/addresses", { cache: "no-store" });
    const data = await res.json().catch(() => ({ addresses: [] }));
    const list: AddressDTO[] = data.addresses ?? [];
    setAddresses(list);
    if (list.length === 0) {
      setAddingAddress(true);
    } else {
      setSelectedAddressId((prev) => prev ?? list.find((a) => a.isDefault)?.id ?? list[0].id);
    }
  }, []);

  const checkAccount = useCallback(async () => {
    try {
      const res = await fetch("/api/account/me", { cache: "no-store" });
      const data = await res.json();
      setMe(data.signedIn ? { signedIn: true, email: data.email } : { signedIn: false, email: null });
      if (data.signedIn) await loadAddresses();
    } catch {
      setMe({ signedIn: false, email: null });
    }
  }, [loadAddresses]);

  useEffect(() => {
    fetch("/api/catalog")
      .then((res) => res.json())
      .then((data: { categories: CatalogCategoryOption[] }) => {
        setCategories(data.categories);
        setNeedsShipping(data.categories.length > 0);
        if (data.categories.length > 0) {
          setCategory(data.categories[0].category);
          setSize(data.categories[0].sizes[0] ?? "");
        }
      })
      .catch(() => setCategories([]));

    // eslint-disable-next-line react-hooks/set-state-in-effect
    checkAccount();
  }, [checkAccount]);

  function onCategoryChange(next: string) {
    setCategory(next);
    const sizes = categories?.find((c) => c.category === next)?.sizes ?? [];
    setSize(sizes[0] ?? "");
  }

  const selectedAddress = addresses?.find((a) => a.id === selectedAddressId) ?? null;

  // Not a <form onSubmit> — CustomerSignIn and AddAddressForm below each
  // render their own <form>, and nesting a <form> inside a <form> is
  // invalid HTML (React hydration error, confirmed live). placeOrder reads
  // from React state directly, so a native form/FormData was never load-
  // bearing here — a plain button click is enough.
  async function placeOrder() {
    setErr(null);

    if (needsShipping && !me?.signedIn) {
      setErr("Sign in first — see above.");
      return;
    }
    if (needsShipping && !selectedAddress) {
      setErr("Add a shipping address first.");
      return;
    }

    setBusy(true);
    const wantsPrepaid = needsShipping && paymentMethod === "prepaid";
    try {
      const payload: Record<string, unknown> = {
        designId: design.id,
        category,
        size,
        color: "Black",
        quantity: Number(quantity) || 1,
        paymentMethod: wantsPrepaid ? "prepaid" : "cod",
      };
      if (needsShipping && selectedAddress) {
        payload.customer = {
          name: selectedAddress.name,
          email: me?.email ?? "",
          phone: selectedAddress.phone,
          address1: selectedAddress.address1,
          address2: selectedAddress.address2 ?? "",
          city: selectedAddress.city ?? "",
          state: selectedAddress.state ?? "",
          pincode: selectedAddress.pincode ?? "",
          country: selectedAddress.country,
        };
      }

      const res = await fetch("/api/designs/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await parseJsonResponse(res);
      if (!res.ok) throw new Error(data.error ?? "Could not place this order.");

      if (!wantsPrepaid) {
        onPlaced();
        return;
      }

      const orderId = data.order.id as string;
      await loadRazorpayScript();
      const createRes = await fetch("/api/orders/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId }),
      });
      const createData = await parseJsonResponse(createRes);
      if (!createRes.ok) throw new Error(createData.error ?? "Could not start payment.");
      if (!createData.keyId) throw new Error("Online payment isn't set up yet — try Cash on Delivery.");

      await new Promise<void>((resolve, reject) => {
        const rzp = new window.Razorpay!({
          key: createData.keyId,
          amount: createData.amountPaise,
          currency: createData.currency,
          order_id: createData.razorpayOrderId,
          name: "wearthistea",
          description: design.title,
          prefill: {
            name: selectedAddress?.name,
            email: me?.email,
            contact: selectedAddress?.phone,
          },
          handler: async (response: {
            razorpay_order_id: string;
            razorpay_payment_id: string;
            razorpay_signature: string;
          }) => {
            try {
              const verifyRes = await fetch("/api/orders/verify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(response),
              });
              const verifyData = await parseJsonResponse(verifyRes);
              if (!verifyRes.ok || !verifyData.ok) {
                reject(new Error("Payment could not be verified. Contact us with your payment id."));
                return;
              }
              resolve();
            } catch {
              reject(new Error("Payment could not be verified. Contact us with your payment id."));
            }
          },
          modal: { ondismiss: () => reject(new Error("Payment cancelled.")) },
        });
        rzp.open();
      });

      onPlaced();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-paper-2 p-5">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h3 className="font-display text-lg font-bold">{design.title}</h3>
            <p className="font-mono text-xs text-ink-soft">“{design.phrase}”</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="shrink-0 text-ink-soft hover:text-ink">
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>

        <label htmlFor="pick-category" className="kicker text-ink-soft">
          Apparel type
        </label>
        <select
          id="pick-category"
          value={category}
          onChange={(e) => onCategoryChange(e.target.value)}
          className={`mt-1 ${FIELD_CLS}`}
          disabled={!categories || categories.length === 0}
        >
          {(categories ?? []).map((c) => (
            <option key={c.category} value={c.category}>
              {c.label}
            </option>
          ))}
        </select>

        <div className="mt-3">
          {category ? (
            <DesignProductPreview
              designId={design.id}
              category={category}
              brewedImageUrl={brewedImg}
              brewedImageAlt={`${design.title} — design art`}
              garmentColor={design.variantColor || "Black"}
              showDisclaimer
            />
          ) : (
            <div className="flex aspect-[4/5] items-center justify-center rounded-xl bg-paper-2">
              <Loader2 className="h-5 w-5 animate-spin text-ink-soft" aria-hidden />
            </div>
          )}
        </div>

        <div className="mt-4 space-y-2.5">
          <div className="flex gap-2">
            <label className="flex-1">
              <span className="kicker text-ink-soft">Size</span>
              <select
                value={size}
                onChange={(e) => setSize(e.target.value)}
                className={`mt-1 ${FIELD_CLS}`}
              >
                {(selectedCategory?.sizes ?? []).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="w-16">
              <span className="kicker text-ink-soft">Qty</span>
              <input
                type="number"
                min={1}
                max={10}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className={`mt-1 ${FIELD_CLS}`}
              />
            </label>
          </div>

          {needsShipping && (
            <div className="space-y-2.5 border-t border-line pt-2.5">
              {!me ? (
                <Loader2 className="h-4 w-4 animate-spin text-ink-soft" aria-hidden />
              ) : !me.signedIn ? (
                <div>
                  <p className="mb-2 font-mono text-xs text-ink-soft">
                    Sign in to save your address and track this order.
                  </p>
                  <CustomerSignIn onSignedIn={checkAccount} />
                </div>
              ) : addingAddress ? (
                <AddAddressForm
                  hasAny={Boolean(addresses?.length)}
                  onSaved={(address) => {
                    setAddresses((prev) => [address, ...(prev ?? [])]);
                    setSelectedAddressId(address.id);
                    setAddingAddress(false);
                  }}
                  onCancel={() => setAddingAddress(false)}
                />
              ) : (
                <div>
                  {addresses && addresses.length > 1 && (
                    <select
                      value={selectedAddressId ?? ""}
                      onChange={(e) => setSelectedAddressId(e.target.value)}
                      className={`${FIELD_CLS} mb-2`}
                    >
                      {addresses.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.label || a.name} — {a.address1}
                        </option>
                      ))}
                    </select>
                  )}
                  {selectedAddress && (
                    <p className="rounded-lg border border-line bg-paper p-2.5 font-mono text-xs text-ink-soft">
                      {selectedAddress.name} · {selectedAddress.phone}
                      <br />
                      {[selectedAddress.address1, selectedAddress.city, selectedAddress.state, selectedAddress.pincode]
                        .filter(Boolean)
                        .join(", ")}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => setAddingAddress(true)}
                    className="mt-2 font-mono text-[11px] font-bold uppercase tracking-widest text-ink-soft hover:text-ink"
                  >
                    + Add another address
                  </button>
                </div>
              )}

              {me?.signedIn && !addingAddress && addresses && addresses.length > 0 && (
                <>
                  <div className="flex gap-3 pt-1">
                    <label className="flex items-center gap-1.5 font-mono text-[11px] text-ink">
                      <input
                        type="radio"
                        name="paymentMethod"
                        checked={paymentMethod === "prepaid"}
                        onChange={() => setPaymentMethod("prepaid")}
                      />
                      Pay now
                    </label>
                    <label className="flex items-center gap-1.5 font-mono text-[11px] text-ink">
                      <input
                        type="radio"
                        name="paymentMethod"
                        checked={paymentMethod === "cod"}
                        onChange={() => setPaymentMethod("cod")}
                      />
                      Cash on delivery
                    </label>
                  </div>
                  <p className="font-mono text-[10px] leading-relaxed text-ink-soft">
                    {paymentMethod === "prepaid"
                      ? "Pay online now — we print & ship after a quick review."
                      : "Cash on delivery · we print & ship after a quick review."}
                  </p>
                </>
              )}
            </div>
          )}

          <div className="flex gap-2 pt-0.5">
            <button
              type="button"
              onClick={placeOrder}
              disabled={busy || (needsShipping && (!me?.signedIn || addingAddress))}
              className="inline-flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-ink bg-highlight px-4 py-2.5 font-mono text-xs font-bold uppercase tracking-wider text-ink transition-transform duration-200 hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <>
                  {needsShipping && paymentMethod === "prepaid" ? "Pay & place order" : "Place order"}{" "}
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </>
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="cursor-pointer rounded-xl border-2 border-line px-3 py-2.5 font-mono text-xs font-bold uppercase tracking-wider text-ink-soft transition-colors hover:border-ink hover:text-ink disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
          {err && <p className="font-mono text-xs text-pink-ink">{err}</p>}
        </div>
      </div>
    </div>
  );
}
