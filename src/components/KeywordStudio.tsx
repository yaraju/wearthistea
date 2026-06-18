"use client";

import { useState, useEffect, type ChangeEvent, type FormEvent } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { Sparkles, Loader2, Check, AlertTriangle, ArrowRight } from "lucide-react";
import type { DesignDTO, GenerateResponse, VariantOptionsDTO } from "@/lib/types";

const SKELETON_COUNT = 5; // matches default settings.optionsPerKeyword


type Phase = "idle" | "loading" | "done" | "error";

/** Translate raw API errors into a one-line human reason. */
function friendlyError(msg: string): string {
  if (/limit:\s*0|RESOURCE_EXHAUSTED|free_tier|quota|\b429\b/i.test(msg)) {
    return "Image quota is 0 on the free tier — enable billing on your Gemini API project, or switch the image provider.";
  }
  if (/no image data|returned no image/i.test(msg)) {
    return "Model returned no image — try a different GEMINI_IMAGE_MODEL.";
  }
  return msg.length > 160 ? msg.slice(0, 157) + "…" : msg;
}

export default function KeywordStudio() {
  const [keyword, setKeyword] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [catalog, setCatalog] = useState<{ categories: any[] }>({ categories: [] });
  const [selectedProduct, setSelectedProduct] = useState<any>(null);
  const [selectedColor, setSelectedColor] = useState("Black");
  const [examples, setExamples] = useState<string[]>([]);
  const reduce = useReducedMotion();

  useEffect(() => {
    fetch("/api/catalog")
      .then(res => res.json())
      .then(data => {
        setCatalog(data);
        // Default: Mens' Clothing -> Half Sleeve Round Neck T-shirt -> Black
        const mensClothing = data.categories?.find((c: any) => c.name.toLowerCase().includes("men"));
        const defaultProduct = mensClothing?.products?.find((p: any) => p.name.toLowerCase().includes("half sleeve round neck"));
        
        if (defaultProduct) {
          setSelectedProduct(defaultProduct);
          if (defaultProduct.colors.includes("Black")) {
            setSelectedColor("Black");
          } else if (defaultProduct.colors.length > 0) {
            setSelectedColor(defaultProduct.colors[0]);
          }
        } else if (data.categories?.length > 0 && data.categories[0].products?.length > 0) {
          const firstProd = data.categories[0].products[0];
          setSelectedProduct(firstProd);
          setSelectedColor(firstProd.colors[0] || "Black");
        }
      })
      .catch(err => console.error("Failed to fetch catalog", err));

    fetch("/api/gossip-examples")
      .then(res => res.json())
      .then(data => {
        if (data.examples && data.examples.length > 0) {
          setExamples(data.examples);
        }
      })
      .catch(err => console.error("Failed to fetch gossip examples", err));
  }, []);

  async function spill(seed?: string) {
    const tea = (seed ?? keyword).trim();
    if (tea.length < 2) return;
    if (seed) setKeyword(seed);
    setPhase("loading");
    setError(null);
    setResult(null);

    const selectedCategory = catalog.categories.find(c => c.products.some((p: any) => p.id === selectedProduct?.id));

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          keyword: tea,
          category: selectedCategory?.name,
          productType: selectedProduct?.name,
          color: selectedColor
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
      setResult(data as GenerateResponse);
      setPhase("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed.");
      setPhase("error");
    }
  }

  return (
    <div id="studio" className="w-full">
      {/* Input card */}
      <div className="sticker sticker-pink rounded-2xl bg-paper-2 p-2 sm:p-3">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex flex-1 flex-col gap-2">
              <label htmlFor="product-select" className="px-4 font-mono text-xs font-bold uppercase tracking-wider text-ink-soft">
                Product & Style
              </label>
              <select
                id="product-select"
                className="mx-2 rounded-xl bg-paper-1 px-4 py-3 font-mono text-sm text-ink focus:outline-none"
                value={selectedProduct?.id || ""}
                onChange={(e) => {
                  const prodId = parseInt(e.target.value);
                  const prod = catalog.categories.flatMap(c => c.products).find(p => p.id === prodId);
                  setSelectedProduct(prod);
                  if (prod && !prod.colors.includes(selectedColor)) {
                    setSelectedColor(prod.colors[0] || "Black");
                  }
                }}
              >
                {catalog.categories.map((cat) => (
                  <optgroup key={cat.id} label={cat.name}>
                    {cat.products.map((prod: any) => (
                      <option key={prod.id} value={prod.id}>
                        {prod.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-2">
              <label className="px-4 font-mono text-xs font-bold uppercase tracking-wider text-ink-soft">
                Color
              </label>
              <div className="mx-2 flex flex-wrap gap-2 px-2 py-1">
                {selectedProduct?.colors.map((color: string) => (
                  <button
                    key={color}
                    onClick={() => setSelectedColor(color)}
                    title={color}
                    className={`h-8 w-8 rounded-full border-2 transition-all ${
                      selectedColor === color ? "border-pink scale-110 shadow-md" : "border-transparent opacity-70 hover:opacity-100"
                    }`}
                    style={{ 
                      backgroundColor: color.toLowerCase() === "white" ? "#FFFFFF" : color.toLowerCase() === "black" ? "#000000" : color.toLowerCase() 
                    }}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-end border-t border-ink/5 pt-3">
            <label htmlFor="tea" className="sr-only">
              Spill the tea — describe a piece of drama
            </label>
            <textarea
              id="tea"
              rows={1}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  spill();
                }
              }}
              placeholder="Spill the tea…  (a feud, a moment, a vibe)"
              maxLength={280}
              autoComplete="off"
              enterKeyHint="go"
              aria-describedby="tea-hint"
              className="tea-input bg-transparent px-4 py-4 font-mono text-base text-ink placeholder:text-ink-soft/70 focus:outline-none sm:text-lg"
            />
            <button
              onClick={() => spill()}
              disabled={phase === "loading" || keyword.trim().length < 2}
              className="group inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-xl bg-pink px-6 py-4 font-mono text-sm font-bold uppercase tracking-wider text-paper transition-colors duration-200 hover:bg-pink-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              {phase === "loading" ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  Brewing…
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" aria-hidden />
                  Brew designs
                </>
              )}
            </button>
          </div>
        </div>
      </div>
      <span id="tea-hint" className="visually-hidden">
        Describe a piece of drama, then press Enter to generate five t-shirt
        designs. Shift+Enter adds a new line.
      </span>

      {/* Example chips */}
      {examples.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="kicker text-ink-soft">try:</span>
          {examples.map((ex) => (
            <button
              key={ex}
              onClick={() => spill(ex)}
              disabled={phase === "loading"}
              className="cursor-pointer rounded-full border border-line bg-paper-2 px-3 py-1.5 text-sm text-ink-soft transition-colors duration-200 hover:border-ink hover:text-ink disabled:opacity-50"
            >
              {ex}
            </button>
          ))}
        </div>
      )}

      {/* Polite announcement for assistive tech when results are ready. */}
      <div aria-live="polite" className="visually-hidden">
        {phase === "done" && result
          ? `${result.designs.length} designs ready for ${result.keyword}.`
          : ""}
      </div>

      {/* Results */}
      <div aria-busy={phase === "loading"}>
        <AnimatePresence mode="wait">
          {phase === "loading" && <LoadingGrid key="loading" reduce={reduce} />}

          {phase === "error" && (
            <motion.div
              key="error"
              role="alert"
              initial={reduce ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="sticker mt-8 flex items-start gap-3 rounded-xl bg-paper-2 p-5"
            >
              <AlertTriangle
                className="mt-0.5 h-5 w-5 shrink-0 text-pink"
                aria-hidden
              />
              <div>
                <p className="font-semibold">The kettle broke.</p>
                <p className="mt-1 text-sm text-ink-soft">{error}</p>
              </div>
            </motion.div>
          )}

          {phase === "done" && result && (
            <motion.div
              key="done"
              initial={reduce ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              className="mt-10"
            >
              <div className="mb-5 flex items-end justify-between gap-4">
                <h2 className="headline text-2xl sm:text-3xl">
                  Fresh pours on{" "}
                  <span className="marker">“{result.keyword}”</span>
                </h2>
                <span className="kicker hidden text-ink-soft sm:block">
                  {result.designs.length} options
                </span>
              </div>
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {result.designs.map((d, i) => (
                  <DesignCard
                    key={d.id}
                    design={d}
                    index={i}
                    reduce={reduce}
                    options={result.options}
                  />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function LoadingGrid({ reduce }: { reduce: boolean | null }) {
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={reduce ? undefined : { opacity: 0 }}
      className="mt-10"
    >
      <p className="kicker mb-5 flex items-center gap-2 text-ink-soft">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        steeping the drama into wearable art…
      </p>
      <div
        aria-hidden="true"
        className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3"
      >
        {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
          <div
            key={i}
            className="sticker overflow-hidden rounded-2xl bg-paper-2"
          >
            <div className="aspect-[4/5] alpha-grid motion-safe:animate-pulse" />
            <div className="space-y-2 p-4">
              <div className="h-5 w-2/3 rounded bg-line motion-safe:animate-pulse" />
              <div className="h-3 w-full rounded bg-line motion-safe:animate-pulse" />
            </div>
          </div>
        ))}
      </div>
    </motion.div>
  );
}

const FIELD_CLS =
  "w-full rounded-lg border border-line bg-paper px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-soft/60 focus:border-ink focus:outline-none";

function DesignCard({
  design,
  index,
  reduce,
  options,
}: {
  design: DesignDTO;
  index: number;
  reduce: boolean | null;
  options: VariantOptionsDTO;
}) {
  const [status, setStatus] = useState(design.status);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const needsShipping = options.provider !== "printify";

  const [form, setForm] = useState({
    size: options.sizes[0] ?? "",
    color: options.colors[0] ?? "",
    quantity: "1",
    name: "",
    email: "",
    phone: "",
    address1: "",
    address2: "",
    city: "",
    state: "",
    pincode: "",
    country: options.countries[0] ?? "",
  });

  const set =
    (k: keyof typeof form) =>
    (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  const failed = status === "failed";
  const queued = status === "pending";

  async function placeOrder(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const payload: Record<string, unknown> = {
        designId: design.id,
        size: form.size,
        color: form.color,
        quantity: Number(form.quantity) || 1,
      };
      if (needsShipping) {
        payload.customer = {
          name: form.name,
          email: form.email,
          phone: form.phone,
          address1: form.address1,
          address2: form.address2,
          city: form.city,
          state: form.state,
          pincode: form.pincode,
          country: form.country,
        };
      }
      const res = await fetch("/api/designs/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not place this order.");
      setStatus("pending");
      setOpen(false);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Failed.");
    } finally {
      setBusy(false);
    }
  }

  // Show the clean, transparent print art (what actually gets printed) rather
  // than the tee mockup — it's far more visible and selectable in the grid.
  const img = design.designImagePath || design.productImagePath;

  return (
    <motion.figure
      initial={reduce ? false : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: reduce ? 0 : index * 0.06, duration: 0.35 }}
      className={`sticker group flex flex-col overflow-hidden rounded-2xl bg-paper-2 ${
        queued ? "sticker-tea" : ""
      }`}
    >
      <div className="relative flex aspect-[4/5] items-center justify-center overflow-hidden alpha-grid p-5">
        {img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={img}
            alt={`${design.title} — design art reading “${design.phrase}”`}
            loading="lazy"
            decoding="async"
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center">
            <span className="font-mono text-xs text-ink-soft">
              artwork didn’t render
            </span>
          </div>
        )}
        {design.vibe && (
          <span className="absolute left-3 top-3 max-w-[calc(100%-1.5rem)] truncate rounded-full bg-ink px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-paper">
            {design.vibe}
          </span>
        )}
      </div>

      <figcaption className="flex flex-1 flex-col p-4">
        <h3 className="font-display text-xl font-bold leading-tight">
          {design.title}
        </h3>
        <p className="mt-1 text-sm text-ink-soft">
          “{design.phrase}”
        </p>
        {design.blurb && (
          <p className="mt-2 line-clamp-2 text-xs text-ink-soft/80">
            {design.blurb}
          </p>
        )}

        <div className="mt-4 flex-1" />

        {failed ? (
          <div className="font-mono text-xs text-pink-ink">
            <p className="flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> render failed
            </p>
            {design.errorMessage && (
              <p className="mt-1 line-clamp-3 opacity-80" title={design.errorMessage}>
                {friendlyError(design.errorMessage)}
              </p>
            )}
          </div>
        ) : queued ? (
          <p className="flex items-center gap-1.5 font-mono text-sm font-bold text-tea">
            <Check className="h-4 w-4" aria-hidden /> sent to the drop queue
          </p>
        ) : open ? (
          <form onSubmit={placeOrder} className="mt-1 space-y-2.5">
            <div className="flex gap-2">
              <label className="flex-1">
                <span className="kicker text-ink-soft">Size</span>
                <select
                  aria-label="Size"
                  value={form.size}
                  onChange={set("size")}
                  className={`mt-1 ${FIELD_CLS}`}
                >
                  {options.sizes.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex-1">
                <span className="kicker text-ink-soft">Color</span>
                <select
                  aria-label="Color"
                  value={form.color}
                  onChange={set("color")}
                  className={`mt-1 ${FIELD_CLS}`}
                >
                  {options.colors.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label className="w-16">
                <span className="kicker text-ink-soft">Qty</span>
                <input
                  aria-label="Quantity"
                  type="number"
                  min={1}
                  max={10}
                  value={form.quantity}
                  onChange={set("quantity")}
                  className={`mt-1 ${FIELD_CLS}`}
                />
              </label>
            </div>

            {needsShipping && (
              <div className="space-y-2.5 border-t border-line pt-2.5">
                <input
                  required
                  aria-label="Full name"
                  placeholder="Full name"
                  value={form.name}
                  onChange={set("name")}
                  className={FIELD_CLS}
                />
                <div className="flex gap-2">
                  <input
                    required
                    aria-label="Phone"
                    type="tel"
                    placeholder="Phone"
                    value={form.phone}
                    onChange={set("phone")}
                    className={FIELD_CLS}
                  />
                  <input
                    aria-label="Email"
                    type="email"
                    placeholder="Email (optional)"
                    value={form.email}
                    onChange={set("email")}
                    className={FIELD_CLS}
                  />
                </div>
                <input
                  required
                  aria-label="Address line 1"
                  placeholder="Address line 1"
                  value={form.address1}
                  onChange={set("address1")}
                  className={FIELD_CLS}
                />
                <input
                  aria-label="Address line 2"
                  placeholder="Address line 2 (optional)"
                  value={form.address2}
                  onChange={set("address2")}
                  className={FIELD_CLS}
                />
                <div className="flex gap-2">
                  <input
                    aria-label="City"
                    placeholder="City"
                    value={form.city}
                    onChange={set("city")}
                    className={FIELD_CLS}
                  />
                  <input
                    aria-label="State"
                    placeholder="State"
                    value={form.state}
                    onChange={set("state")}
                    className={FIELD_CLS}
                  />
                </div>
                <div className="flex gap-2">
                  <input
                    aria-label="PIN or ZIP code"
                    placeholder="PIN / ZIP"
                    value={form.pincode}
                    onChange={set("pincode")}
                    className={FIELD_CLS}
                  />
                  <select
                    aria-label="Country"
                    required
                    value={form.country}
                    onChange={set("country")}
                    className={FIELD_CLS}
                  >
                    {options.countries.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="font-mono text-[10px] leading-relaxed text-ink-soft">
                  Cash on delivery · we print &amp; ship after a quick review.
                </p>
              </div>
            )}

            <div className="flex gap-2 pt-0.5">
              <button
                type="submit"
                disabled={busy}
                className="inline-flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-ink bg-highlight px-4 py-2.5 font-mono text-xs font-bold uppercase tracking-wider text-ink transition-transform duration-200 hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <>
                    Place order <ArrowRight className="h-4 w-4" aria-hidden />
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={busy}
                className="cursor-pointer rounded-xl border-2 border-line px-3 py-2.5 font-mono text-xs font-bold uppercase tracking-wider text-ink-soft transition-colors hover:border-ink hover:text-ink disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button
            onClick={() => setOpen(true)}
            className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-ink bg-highlight px-4 py-2.5 font-mono text-xs font-bold uppercase tracking-wider text-ink transition-transform duration-200 hover:-translate-y-0.5"
          >
            Pick this one <ArrowRight className="h-4 w-4" aria-hidden />
          </button>
        )}
        {err && <p className="mt-2 text-xs text-pink-ink">{err}</p>}
      </figcaption>
    </motion.figure>
  );
}
