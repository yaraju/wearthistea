"use client";

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { Sparkles, Loader2, Check, AlertTriangle, ArrowRight, ArrowDown, RotateCcw } from "lucide-react";
import type { DesignDTO, GenerateResponse, DesignMatchDTO } from "@/lib/types";
import { getColorCode } from "@/lib/colors";
import { friendlyError } from "@/lib/error-messages";
import { track } from "@/lib/analytics";
import { getAnonId, ANON_ID_HEADER } from "@/lib/anon-id";
import PickDesignModal from "@/components/PickDesignModal";
import ReviewBadge from "@/components/ReviewBadge";

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

// Rendering happens server-side now (dispatched from /api/generate — see its
// doc comment), so the client's only job here is to poll until every design
// in the batch reaches a terminal status.
const POLL_INTERVAL_MS = 2000;
// Give up refreshing after this long — matches roughly the outer bound of
// the design-render queue's own retry window (deploy.yml) plus slack. A
// design still "generating" past this either succeeded and we just missed
// the last tick, or genuinely needs the card's own "Retry Render" path; we
// don't spin forever on a tab left open indefinitely.
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

// Remembers the most recent brew across a closed/reopened tab — see
// restoreLastBrew() below. Deliberately localStorage, not a cookie: this
// app's Firebase Hosting rewrite only forwards a cookie literally named
// "__session" through to Cloud Run (see anon-id.ts), so any other cookie
// name would silently never round-trip in production.
const LAST_BREW_STORAGE_KEY = "wtt:lastBrew";

function saveLastBrew(keyword: string, batchId: string) {
  try {
    localStorage.setItem(LAST_BREW_STORAGE_KEY, JSON.stringify({ keyword, batchId }));
  } catch {
    // localStorage can throw (private browsing, quota, disabled storage) —
    // losing this is a pure convenience regression, never worth failing the
    // brew itself over.
  }
}

function loadLastBrew(): { keyword: string; batchId: string } | null {
  try {
    const raw = localStorage.getItem(LAST_BREW_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.batchId === "string" && typeof parsed?.keyword === "string") {
      return { keyword: parsed.keyword, batchId: parsed.batchId };
    }
  } catch {
    // ignore — malformed/corrupted value, treat as nothing saved
  }
  return null;
}

// Rotating captions for a "generating" card — the render already happened
// (or is happening) server-side; this is purely a "we're watching it get
// made" feeling, in the brand's chronically-online voice.
const GENERATING_VERBS = [
  "Steeping the tea",
  "Overthinking the font",
  "Consulting the group chat",
  "Arguing with the muse",
  "Committing to the bit",
  "Ironing out the pixels",
  "Summoning main character energy",
  "Vibe-checking the palette",
  "Negotiating with the ink",
  "Rehearsing the read",
  "Doubting every color choice",
  "Manifesting drip",
  "Untangling the drama",
  "Spilling a little more tea",
  "Photosynthesizing",
  "Rewriting the punchline",
  "Googling how shirts work",
  "Bribing the pixels to behave",
  "Practicing the smirk",
  "Cross-referencing the chat",
  "Channeling unhinged creativity",
  "Aligning the kerning",
  "Pretending this is easy",
  "Consulting a Magic 8-Ball",
  "Powering the printer with spite",
  "Fact-checking the tea",
  "Buffering main character energy",
  "Asking the intern (no intern)",
  "Workshopping the smirk",
  "Overanalyzing the vibe",
];

/** Cheap deterministic hash so each card starts on a different verb instead
 * of all five reading the exact same line at once. */
function hashSeed(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Placeholder shown in a card's art box while its design is "generating":
 * a soft blurred blob (brand colors, no image asset) that gradually
 * sharpens over 60 real seconds — timed from this component's own mount via
 * framer-motion's animate prop, which keeps running regardless of parent
 * re-renders (every poll tick) as long as this instance stays mounted — plus
 * a rotating snarky caption. Purely illusory: the art is already done or
 * getting done server-side either way, this is just something nicer to
 * watch than a bare spinner. */
function GeneratingPlaceholder({ seed, reduce }: { seed: string; reduce: boolean | null }) {
  const [verbIndex, setVerbIndex] = useState(() => hashSeed(seed) % GENERATING_VERBS.length);

  useEffect(() => {
    if (reduce) return;
    const id = setInterval(() => {
      setVerbIndex((i) => (i + 1) % GENERATING_VERBS.length);
    }, 2200);
    return () => clearInterval(id);
  }, [reduce]);

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden">
      <motion.div
        initial={reduce ? { filter: "blur(4px)" } : { filter: "blur(28px)" }}
        animate={{ filter: "blur(3px)" }}
        transition={reduce ? { duration: 0 } : { duration: 60, ease: [0.22, 1, 0.36, 1] }}
        className="absolute inset-6 rounded-[42%_58%_53%_47%/48%_42%_58%_52%]"
        style={{
          background:
            "radial-gradient(circle at 32% 28%, var(--color-highlight), var(--color-pink) 55%, var(--color-tea-bright) 100%)",
        }}
        aria-hidden
      />
      <div className="relative z-10 mx-4 grid max-w-[calc(100%-2rem)] rounded-full bg-ink/75 px-3 py-1.5 backdrop-blur-sm">
        {/* Default (sync) mode, not "wait" — the incoming line fades in
            while the outgoing one fades out. With "wait" the gap between
            them is brief but every card in the grid mounts at nearly the
            same instant, so their gaps land in sync too: the whole row of
            captions would blink blank together every ~2.2s. */}
        <AnimatePresence>
          <motion.span
            key={verbIndex}
            initial={reduce ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? undefined : { opacity: 0, y: -4 }}
            transition={{ duration: 0.25 }}
            className="col-start-1 row-start-1 block min-w-0 truncate font-mono text-[11px] font-bold uppercase tracking-wider text-paper"
          >
            {GENERATING_VERBS[verbIndex]}…
          </motion.span>
        </AnimatePresence>
      </div>
    </div>
  );
}

export default function KeywordStudio() {
  const [keyword, setKeyword] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GenerateResponse | null>(null);
  // Fallback for impatient users, never a competing first choice — see the
  // "done" render below, where this always renders BELOW the fresh-brew
  // grid, never above it, even while fresh brews are still rendering.
  const [preBrewed, setPreBrewed] = useState<DesignMatchDTO[]>([]);
  // Apparel type is no longer a brew-time choice (see the plan doc — one
  // design now generates once and gets a Printrove preview product per
  // category, picked at "select this design" time instead). Garment color
  // is likewise no longer picked upfront — the image-generation call itself
  // chooses black or white for the strongest ink contrast and self-reports
  // it, resolved server-side into Design.variantColor once each design's
  // render lands (see prompts.ts's GARMENT_COLOR_CHOICE).
  const [style, setStyle] = useState<"raster" | "svg">("raster");
  const [examples, setExamples] = useState<string[]>([]);
  const reduce = useReducedMotion();
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollDeadline = useRef(0);

  function stopPolling() {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }

  // Rendering happens server-side (see /api/generate's doc comment) — this
  // just refreshes each card from the latest DB state until every design in
  // the batch lands on a terminal status.
  async function pollBatchStatus(batchId: string) {
    try {
      const res = await fetch(`/api/generate/status?batchId=${encodeURIComponent(batchId)}`);
      if (!res.ok) return;
      const data = (await res.json()) as GenerateResponse;
      setResult((prev) => {
        if (!prev || prev.batchId !== batchId) return prev;
        return {
          ...prev,
          designs: prev.designs.map((d) => {
            const updated = data.designs.find((nd) => nd.id === d.id);
            // Preserve fields the status endpoint doesn't carry (e.g. slug,
            // set once at creation) by spreading onto the existing card
            // rather than replacing it outright.
            return updated ? { ...d, ...updated } : d;
          }),
        };
      });
      const stillGenerating = data.designs.some((d) => d.status === "generating");
      if (!stillGenerating) stopPolling();
    } catch (err) {
      console.error("Failed to poll batch status", err);
    }
  }

  function startPolling(batchId: string) {
    stopPolling();
    pollDeadline.current = Date.now() + POLL_TIMEOUT_MS;
    pollTimer.current = setInterval(() => {
      if (Date.now() > pollDeadline.current) {
        stopPolling();
        return;
      }
      pollBatchStatus(batchId);
    }, POLL_INTERVAL_MS);
  }

  useEffect(() => stopPolling, []);

  useEffect(() => {
    fetch("/api/gossip-examples")
      .then(res => res.json())
      .then(data => {
        if (data.examples && data.examples.length > 0) {
          setExamples(data.examples);
        }
      })
      .catch(err => console.error("Failed to fetch gossip examples", err));
  }, []);

  // Fetches the "similar designs" fallback grid for a keyword — shared by a
  // fresh spill() and by the mount-restore effect below, which needs the
  // exact same lookup for whatever keyword it's restoring. Never throws;
  // a failed/slow lookup here must never block or fail the caller.
  function fetchPreBrewed(tea: string) {
    fetch("/api/designs/prebrewed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword: tea }),
    })
      .then((res) => (res.ok ? res.json() : { matches: [] }))
      .then((data: { matches: DesignMatchDTO[] }) => setPreBrewed(data.matches ?? []))
      .catch((err) => console.error("Failed to fetch pre-brewed matches", err));
  }

  // Restore whatever brew was still in flight (or just finished) the last
  // time this browser had the studio open — so closing the tab mid-brew
  // doesn't read as having lost it. Runs once on mount; a batch that's since
  // been deleted or never existed just 404s and we leave the studio empty.
  useEffect(() => {
    const saved = loadLastBrew();
    if (!saved) return;
    (async () => {
      try {
        const res = await fetch(`/api/generate/status?batchId=${encodeURIComponent(saved.batchId)}`);
        if (!res.ok) return;
        const data = (await res.json()) as GenerateResponse;
        setKeyword(saved.keyword);
        setResult(data);
        setPhase("done");
        fetchPreBrewed(saved.keyword);
        if (data.designs.some((d) => d.status === "generating")) {
          startPolling(saved.batchId);
        }
      } catch (err) {
        console.error("Failed to restore last brew", err);
      }
    })();
    // Intentionally run once on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function spill(seed?: string) {
    const tea = (seed ?? keyword).trim();
    if (tea.length < 2) return;
    if (seed) setKeyword(seed);
    stopPolling();
    setPhase("loading");
    setError(null);
    setResult(null);
    setPreBrewed([]);
    track("brew_started", { keyword: tea });

    // Fired in parallel, never awaited before the fresh-brew request below —
    // a slow or failed match lookup must never delay or block brewing, which
    // is the actual product. Resolves independently and renders below the
    // fresh-brew grid whenever it's ready.
    fetchPreBrewed(tea);

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json", [ANON_ID_HEADER]: getAnonId() },
        body: JSON.stringify({
          keyword: tea,
          // No productId/category/productType — apparel type is a pick-time
          // choice now. No color either — garment color is no longer picked
          // upfront; the image-generation call itself chooses it (see
          // prompts.ts's GARMENT_COLOR_CHOICE).
          style
        }),
      });
      const data = await parseJsonResponse(res);
      if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
      const generated = data as GenerateResponse;
      setResult(generated);
      setPhase("done");
      track("generate_designs", {
        keyword: tea,
        backLayouts: generated.designs.map((d) => d.backLayout).join(","),
      });
      // Concepts come back fast; artwork rendering was already dispatched
      // server-side by /api/generate itself (see its doc comment) — it
      // keeps going whether or not this tab stays open. Persist the batch so
      // reopening the tab later restores it (see the mount effect above),
      // then poll until every card lands on a terminal status.
      saveLastBrew(tea, generated.batchId);
      startPolling(generated.batchId);
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
          // Spread onto the existing card rather than replacing it outright —
          // /api/generate/retry's response doesn't carry `slug` (it's set
          // once at creation in /api/generate and excluded from Prisma's
          // return shape as an Unsupported column), so a full replace would
          // silently drop the link this card already has.
          designs: prev.designs.map(d =>
            d.id === designId ? { ...d, ...updatedDesign } : d
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

      <p className="mt-6 flex items-center justify-center gap-2 font-mono text-xs text-ink-soft">
        <ArrowDown
          className="h-3.5 w-3.5 motion-safe:animate-bounce"
          aria-hidden
        />
        real designs appear right here
      </p>

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
                  />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Fallback for impatient users — always rendered below the fresh
            grid above (loading or done), never as a competing first choice.
            Appears once/if matches resolve; nothing shown otherwise. */}
        {preBrewed.length > 0 && (
          <div className="mt-10">
            <div className="mb-5 flex items-end justify-between gap-4">
              <h2 className="headline text-xl sm:text-2xl">
                In a hurry? Someone’s already brewed something close
              </h2>
              <span className="kicker hidden text-ink-soft sm:block">
                {preBrewed.length} matches
              </span>
            </div>
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {preBrewed.map((m, i) => (
                <PreBrewedCard key={m.id} match={m} index={i} reduce={reduce} />
              ))}
            </div>
          </div>
        )}
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
}: {
  design: DesignDTO;
  index: number;
  reduce: boolean | null;
  onRetry?: (id: string) => void;
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

  // Garment color is no longer picked upfront — it's resolved server-side
  // from the actual rendered art (see prompts.ts's GARMENT_COLOR_CHOICE) and
  // lands on design.variantColor once the render completes. Until then (or
  // for a legacy row that somehow never got one), show a transparency
  // checkerboard instead of guessing a color.
  const swatchColor = design.variantColor ? getColorCode(design.variantColor) : null;

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
        className={`relative flex aspect-[4/5] items-center justify-center overflow-hidden p-5 ${
          swatchColor ? "" : "alpha-grid"
        }`}
        style={swatchColor ? { backgroundColor: swatchColor } : undefined}
      >
        <AnimatePresence mode="sync">
          {img ? (
            <motion.img
              key="art"
              initial={reduce ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.3 }}
              src={img}
              alt={`${design.title} — design art reading “${design.phrase}”`}
              loading="lazy"
              decoding="async"
              className="max-h-full max-w-full object-contain"
            />
          ) : generating ? (
            <motion.div
              key="generating"
              exit={reduce ? undefined : { opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="absolute inset-0"
            >
              <GeneratingPlaceholder seed={design.id} reduce={reduce} />
            </motion.div>
          ) : (
            <motion.div
              key="failed-art"
              initial={reduce ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex h-full items-center justify-center p-6 text-center"
            >
              <span className="font-mono text-xs text-ink-soft">
                artwork didn’t render
              </span>
            </motion.div>
          )}
        </AnimatePresence>
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

function PreBrewedCard({
  match,
  index,
  reduce,
}: {
  match: DesignMatchDTO;
  index: number;
  reduce: boolean | null;
}) {
  const [design, setDesign] = useState<DesignDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const img = match.designPreviewImagePath || match.productPreviewImagePath;

  // /api/designs/prebrewed returns a lean match DTO, not a full DesignDTO —
  // fetch the full record (needed by PickDesignModal) only once the visitor
  // actually wants to pick it, rather than eagerly for every match shown.
  async function pickThisOne() {
    if (!match.slug && !match.id) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`/api/designs/${match.slug || match.id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load this design.");
      track("select_design", { designId: match.id, prebrewed: true });
      setDesign(data.design as DesignDTO);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load this design.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <motion.figure
      initial={reduce ? false : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: reduce ? 0 : index * 0.06, duration: 0.35 }}
      className="sticker group flex flex-col overflow-hidden rounded-2xl bg-paper-2"
    >
      <div
        className={`relative flex aspect-[4/5] items-center justify-center overflow-hidden p-5 ${
          match.variantColor ? "" : "alpha-grid"
        }`}
        style={match.variantColor ? { backgroundColor: getColorCode(match.variantColor) } : undefined}
      >
        {img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={img}
            alt={`${match.title} — design art reading “${match.phrase}”`}
            loading="lazy"
            decoding="async"
            className="max-h-full max-w-full object-contain"
          />
        ) : null}
        <span className="absolute left-3 top-3">
          <ReviewBadge status={match.reviewBadge} />
        </span>
      </div>

      <figcaption className="flex flex-1 flex-col p-4">
        <h3 className="font-display text-xl font-bold leading-tight">{match.title}</h3>
        <p className="mt-1 text-sm text-ink-soft">“{match.phrase}”</p>
        {match.blurb && <p className="mt-2 line-clamp-2 text-xs text-ink-soft/80">{match.blurb}</p>}

        <div className="mt-4 flex-1" />

        {err && <p className="mb-2 font-mono text-xs text-pink-ink">{friendlyError(err)}</p>}
        <button
          onClick={pickThisOne}
          disabled={loading}
          className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-ink bg-highlight px-4 py-2.5 font-mono text-xs font-bold uppercase tracking-wider text-ink transition-transform duration-200 hover:-translate-y-0.5 disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <>
              Pick this one <ArrowRight className="h-4 w-4" aria-hidden />
            </>
          )}
        </button>
      </figcaption>

      {design && (
        <PickDesignModal design={design} onClose={() => setDesign(null)} onPlaced={() => setDesign(null)} />
      )}
    </motion.figure>
  );
}
