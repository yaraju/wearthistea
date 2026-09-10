"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { Sparkles, Loader2, Check, AlertTriangle, ArrowRight, RotateCcw } from "lucide-react";
import type { DesignDTO, GenerateResponse } from "@/lib/types";
import { getColorCode } from "@/lib/colors";
import { friendlyError } from "@/lib/error-messages";
import { track } from "@/lib/analytics";
import { getAnonId, ANON_ID_HEADER } from "@/lib/anon-id";
import PickDesignModal from "@/components/PickDesignModal";

const SKELETON_COUNT = 5; // matches default settings.optionsPerKeyword


type Phase = "idle" | "loading" | "done" | "error";

/** Parse a fetch Response as JSON, surfacing a clear error for a non-JSON
 * response (e.g. an HTML 502 from an upstream gateway) instead of letting
 * `res.json()` throw its raw "Unexpected token '<'" parse error. */
async function parseJsonResponse(res: Response): Promise<any> {
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error(
      res.ok
        ? "Unexpected response from the server."
        : `Server error (${res.status}). Please try again in a moment.`
    );
  }
  return res.json();
}

/** Run `worker` over `items`, at most `concurrency` at a time. Used to spread
 * per-design render requests out instead of firing them all at once — they
 * all land on the same backend container, and full concurrency pushes each
 * request's latency close to the hosting proxy's timeout (see spill()). */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  async function run(): Promise<void> {
    const i = next++;
    if (i >= items.length) return;
    await worker(items[i]);
    return run();
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}

export default function KeywordStudio() {
  const [keyword, setKeyword] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GenerateResponse | null>(null);
  // Apparel type is no longer a brew-time choice (see the plan doc — one
  // design now generates once and gets a Printrove preview product per
  // category, picked at "select this design" time instead). Color stays
  // here since it genuinely affects generation (ink-contrast direction).
  const [colors, setColors] = useState<string[]>(["Black"]);
  const [selectedColor, setSelectedColor] = useState("Black");
  const [style, setStyle] = useState<"raster" | "svg">("raster");
  const [examples, setExamples] = useState<string[]>([]);
  const reduce = useReducedMotion();

  useEffect(() => {
    fetch("/api/catalog")
      .then(res => res.json())
      .then((data: { colors: string[] }) => {
        if (data.colors?.length > 0) {
          setColors(data.colors);
          setSelectedColor(data.colors.includes("Black") ? "Black" : data.colors[0]);
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
    track("brew_started", { keyword: tea });

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", [ANON_ID_HEADER]: getAnonId() },
        body: JSON.stringify({
          keyword: tea,
          // No productId/category/productType — apparel type is a pick-time
          // choice now. The server defaults category to "men" purely as
          // flavor text in the render prompt ("printed on a Black T-shirt");
          // it no longer determines what's actually sellable.
          color: selectedColor,
          style
        }),
      });
      const data = await parseJsonResponse(res);
      if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
      setResult(data as GenerateResponse);
      setPhase("done");
      track("generate_designs", { keyword: tea });
      // Concepts come back fast; each design's artwork is rendered by its own
      // request so no single request has to finish the whole batch inside
      // the hosting proxy's timeout. Each card flips from "generating" to
      // done/failed independently as its request completes. Capped at 2
      // in-flight renders — 5 at once all land on the same Cloud Run
      // container (concurrency isn't scaled per-request) and contend hard
      // enough for CPU that individual renders stretch from ~30s to ~55-58s,
      // eating almost all of the ~60s proxy budget. See the production
      // incident note in design-quality-improvement-plan.md.
      runWithConcurrency(
        (data as GenerateResponse).designs.map((d) => d.id),
        2,
        retryDesign
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Generation failed.";
      track("brew_failed", { keyword: tea, reason: message });
      setError(message);
      setPhase("error");
    }
  }

  async function retryDesign(designId: string) {
    setResult(prev => {
      if (!prev) return null;
      return {
            ...prev,
            designs: prev.designs.map(d => 
              d.id === designId ? { ...d, status: 'generating' } : d
            )
          };
    });

    try {
      const res = await fetch("/api/generate/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json", [ANON_ID_HEADER]: getAnonId() },
        body: JSON.stringify({ designId }),
      });
      const data = await parseJsonResponse(res);
      if (!res.ok) throw new Error(data.error ?? "Retry failed.");
      
      const updatedDesign = data.design as DesignDTO;
      setResult(prev => {
        if (!prev) return null;
        return {
          ...prev,
          designs: prev.designs.map(d => 
            d.id === designId ? updatedDesign : d
          )
        };
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Retry failed.";
      setResult(prev => {
        if (!prev) return null;
        return {
          ...prev,
          designs: prev.designs.map(d => 
            d.id === designId ? { ...d, status: 'failed', errorMessage: msg } : d
          )
        };
      });
    }
  }

  return (
    <div id="studio" className="w-full">
      {/* Input card */}
      <div className="sticker sticker-pink rounded-2xl bg-paper-2 p-2 sm:p-3">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
            <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-initial">
              <label htmlFor="color-select" className="px-2 font-mono text-xs font-bold uppercase tracking-wider text-ink-soft">
                Color
              </label>
              <select
                id="color-select"
                name="color-select"
                className="w-full rounded-xl bg-paper-1 px-4 py-3 font-mono text-sm text-ink focus:outline-none"
                value={selectedColor}
                onChange={(e) => setSelectedColor(e.target.value)}
              >
                {colors.map((color) => (
                  <option key={color} value={color}>
                    {color}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-initial">
              <label htmlFor="style-select" className="px-2 font-mono text-xs font-bold uppercase tracking-wider text-ink-soft">
                Art Style
              </label>
              <select
                id="style-select"
                className="w-full rounded-xl bg-paper-1 px-4 py-3 font-mono text-sm text-ink focus:outline-none"
                value={style}
                onChange={(e) => setStyle(e.target.value as "raster" | "svg")}
              >
                <option value="raster">Streetwear Raster</option>
                <option value="svg">Minimalist Line Art</option>
              </select>
            </div>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-end border-t border-ink/5 pt-3">
            <label htmlFor="tea" className="sr-only">
              Spill the tea — describe a piece of drama
            </label>
            <textarea
              id="tea"
              name="tea"
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
              className="tea-input w-full flex-1 bg-transparent px-4 py-4 font-mono text-base text-ink placeholder:text-ink-soft/70 focus:outline-none sm:text-lg"
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
                <p className="mt-1 text-sm text-ink-soft">{error && friendlyError(error)}</p>
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
                    onRetry={retryDesign}
                    selectedColor={selectedColor}
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

function DesignCard({
  design,
  index,
  reduce,
  onRetry,
  selectedColor,
}: {
  design: DesignDTO;
  index: number;
  reduce: boolean | null;
  onRetry?: (id: string) => void;
  selectedColor: string;
}) {
  const [status, setStatus] = useState(design.status);
  const [open, setOpen] = useState(false);

  const failed = design.status === "failed";
  const generating = design.status === "generating";
  const queued = status === "pending";

  // Show the clean, transparent print art (what actually gets printed) rather
  // than the tee mockup — it's far more visible and selectable in the grid.
  // Screen-quality preview only — the full-res print file never reaches
  // the browser.
  const img = design.designPreviewImagePath || design.productPreviewImagePath;

  return (
    <motion.figure
      initial={reduce ? false : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: reduce ? 0 : index * 0.06, duration: 0.35 }}
      className={`sticker group flex flex-col overflow-hidden rounded-2xl bg-paper-2 ${
        queued ? "sticker-tea" : ""
      }`}
    >
      <div
        className="relative flex aspect-[4/5] items-center justify-center overflow-hidden p-5"
        style={{ backgroundColor: getColorCode(selectedColor) }}
      >
        {img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={img}
            alt={`${design.title} — design art reading “${design.phrase}”`}
            loading="lazy"
            decoding="async"
            className="max-h-full max-w-full object-contain"
          />
        ) : generating ? (
          <div className="flex h-full items-center justify-center p-6 text-center">
            <Loader2 className="h-5 w-5 animate-spin text-ink-soft" aria-hidden />
          </div>
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
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRetry?.(design.id);
              }}
              className="mt-2 inline-flex items-center gap-1 font-mono text-xs font-bold uppercase tracking-widest text-pink transition-colors hover:text-pink-ink"
            >
              <RotateCcw className="h-3 w-3" /> Retry Render
            </button>
          </div>
        ) : generating ? (
          <div className="flex items-center gap-1.5 font-mono text-xs text-ink-soft">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> rerendering…
          </div>
        ) : queued ? (
          <p className="flex items-center gap-1.5 font-mono text-sm font-bold text-tea">
            <Check className="h-4 w-4" aria-hidden />
            sent to the drop queue
          </p>
        ) : (
          <button
            onClick={() => {
              track("select_design", { designId: design.id });
              setOpen(true);
            }}
            className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-ink bg-highlight px-4 py-2.5 font-mono text-xs font-bold uppercase tracking-wider text-ink transition-transform duration-200 hover:-translate-y-0.5"
          >
            Pick this one <ArrowRight className="h-4 w-4" aria-hidden />
          </button>
        )}
      </figcaption>

      {open && (
        <PickDesignModal
          design={design}
          onClose={() => setOpen(false)}
          onPlaced={() => {
            setStatus("pending");
            setOpen(false);
          }}
        />
      )}
    </motion.figure>
  );
}
