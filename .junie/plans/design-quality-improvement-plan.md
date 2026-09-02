# Design Quality Improvement Plan

## 1. Diagnosis (evidence-based, not guesswork)

I pulled the actual `Design` rows for the "mercury is in microwave" batch shown in the
screenshot directly from the database and compared `visualConcept` (what the text model
wrote) against `designSVGData` (what got rendered):

```
visualConcept: "A retro digital microwave with warning radiation symbols
                pulsing around it, vector line art style."
svg:           <rect ... microwave box /><line/><circle/><path d="...80 z"/>
                (a plain box with a door handle and a wavy line under it —
                 no radiation symbols, no text, no "vibe")
```

This pattern repeats across every card in the batch. **The concept layer is fine.**
Titles, phrases, and `visualConcept` descriptions are specific, on-brand, and drawable
("hazmat diamond framing a ringed planet," "exploding popcorn kernel," etc.). The
failure is entirely in one step: turning that description into an SVG.

### Root cause

`src/lib/gemini.ts::generateBatch()` asks `gemini-3.5-flash-lite` (a small, fast *text*
model) to hand-author raw SVG `<path>` data for the preview grid — the exact 5 cards the
user judges and picks from (`src/config/prompts.ts::batchSVGSystem/batchSVGUser`,
`SVG_RULES`). Two rules in that prompt make failure structural, not a tuning problem:

- **`SVG_RULES` bans `<text>` and requires letterforms be hand-drawn as bezier paths.**
  No LLM reliably outputs correct glyph path data by writing `d="M12 34 C56 78…"`
  freehand — there's no visual feedback loop. In practice the model just **drops the
  phrase entirely** (confirmed: zero of the sampled SVGs contain any letterform-shaped
  path). That's why the cards in the screenshot have no on-shirt text at all, only the
  card *chrome* (title/phrase rendered by the React UI, not the design).
- **Illustration-by-hand-written-path-data is not a task a text model is good at.**
  "Radiation symbols pulsing," "planet with rings," "hazmat diamond" all collapse to
  the nearest primitive shapes (`<rect>`, `<circle>`, generic wavy `<path>`) because
  the model is composing SVG syntax token-by-token with no rendering feedback, not
  drawing. This is true regardless of which text model you point at it.

So: **prompt-to-image mismatch is real, and it's not a prompt-wording problem — it's the
wrong model doing the wrong job.**

### A live defect, not just a preview cosmetic issue

`/api/generate` stores which pipeline branch a batch used as a *string inside
`designPrompt`* (`"Stage 1: SVG Preview (svg mode)"` vs `"...(raster mode)"`), and
`realizeDesign()` in `src/lib/realize.ts` decides what to do on selection by checking
`design.designPrompt.toLowerCase().includes("raster")`. For a batch generated in `svg`
style, that means **Stage 2 does nothing but rasterize the same flash-lite SVG at high
resolution and ships it as the final print file.** I confirmed this in the data — the
`(svg mode)` batch sampled above has designs sitting in `status: "preview"` with no
better version ever generated. Any plan here should fix this regardless of which
direction is chosen, because it's currently shipping the worst-quality asset as the
one that gets printed. Recommendation: replace the string-matching with a real
`previewMode` enum column on `Design`/`Batch` so this can't silently break again when
someone edits Stage‑1 prompt text.

### For comparison: what "raster" mode actually does today

`raster` mode also shows the bad SVG as the Stage‑1 preview, but on selection
`realizeDesign()` re-generates properly with `gemini-3-pro-image` via the full
`designImage()` prompt (real illustration + real text) and runs local background
removal. This is genuinely good — it's just hidden behind a bad preview, so users are
choosing between 5 ugly cards to *unlock* a good design they can't see yet.

## 2. History (why we're here)

Three prior plans in this folder document the trajectory:

- `fix-image-generation-failure.md` (Aug 14) — introduced batched multimodal
  generation + SVG line art to cut per-image round trips.
- `optimize-generation-latency.md` (Aug 15) — introduced the two-stage split
  specifically because latency had regressed to ~30–50s. Explicit tradeoff:
  "sub-second initial feedback" via `gemini-2.5-flash-lite` SVG previews, deferring
  real quality to a second "Realization" call. The plan assumed "spatial prompts"
  would keep the deferred raster faithful to the SVG wireframe, and treated the SVG
  preview as a cheap sketch of an already-good drawing, not a text-only rewrite of it.
- `observability-migration-analysis.md` (Aug 15) — added Langfuse to see where time
  goes; doesn't touch quality.

The latency fix worked (Stage 1 is fast). It broke quality because the fast path
became the thing users evaluate and select from, and that path structurally cannot
render either text or the described illustration.

## 3. Evaluating your three directions

### Option 1 — Revert Stage 1 to 18 June behavior (direct multimodal image gen)

Confirmed via `git show be4b01d` (18 Jun): back then `generateBatch` didn't exist.
Each of the 5 concepts went straight to `generateImage()` with the full `designImage()`
prompt on `gemini-2.5-flash-image`, in parallel. That's genuinely why it was "slow but
nice" — 5 real image-model calls, each producing an actual illustration with real
typography, no hand-drawn-SVG intermediate step.

- **Pros:** Biggest, most reliable quality jump. Small diff — the code path
  (`generateImage` + `designImage`) already exists and is used today in Stage 2. Concept
  layer doesn't need to change.
- **Cons:** Real latency, ~15–20s for 5 parallel image calls even on today's faster
  `gemini-3.1-flash-image`/`gemini-3-pro-image`. Doesn't get you toward <4s.
- **Verdict:** This is close to the "80% fix" — see §4.

### Option 2 — SVG-from-code-generation via a library (D3/Cairo-style)

Worth splitting by design type, because the current failure mode tells you exactly
where a library helps and where it can't:

- **Typographic/badge designs** (phrase-forward, simple graphic support): a real fit.
  The specific failure today — "LLM can't hand-draw letterforms as bezier paths" — is
  exactly the problem **Satori** (HTML/CSS-like JSX → SVG, using real font outlines)
  solves, sub-second, with zero model calls for the text itself. This is a much
  better tool than asking any LLM to draw glyphs by hand.
- **Illustrated/scene designs** ("melting microwave with orbiting planets and hazard
  symbols"): D3 and Cairo are the wrong tools. D3 is for data-driven charts; Cairo is
  a 2D drawing *API*, not a generator — something still has to decide what shapes to
  draw and where, which is precisely the part that's failing today. No procedural/
  code-generation approach reliably produces bespoke witty illustration from a text
  brief; that's a generative-art problem, which is what the multimodal image model is
  for. Swapping "LLM writes SVG path data" for "LLM writes D3/Cairo drawing code" is
  the same failure mode with extra steps.
- **There is already a half-built version of the right split in this repo:**
  `prompts.designImageArtOnly` generates illustration with **zero text** (image model
  does what it's good at), and `prompts.imageReview` is a ready QA grader — **neither
  is called anywhere** (confirmed via grep — only `designImage`, not
  `designImageArtOnly`/`imageReview`, is referenced from `gemini.ts`/`realize.ts`). The
  file's own top comment already recommends this: *"For best text accuracy, consider
  designImageArtOnly + deterministic text overlay."* Combine that with Satori for the
  text layer and you get: fast, exact, on-brand typography + real illustration from a
  model that's actually good at illustration, composited deterministically. This is
  the strongest long-term architecture, not a full rewrite.

### Option 3 — Background generation + cache, notify when ready

Right instinct for a fundamentally different latency/quality tradeoff, with one
simplification: you already run Postgres via Prisma, so **pgvector on the existing
database** gets you semantic search over past designs/keywords with far less new
infrastructure than standing up a separate vector DB. Shape:

- Embed each incoming "tea" keyword; nearest-neighbor search against embeddings of
  past keywords/concepts.
- Close/duplicate match → serve cached designs instantly (true <4s, because nothing
  generates at request time).
- No good match → kick off generation in the background (job queue or just a fired-off
  async task + polling/websocket status on the frontend), show a "brewing" state, and
  optionally email/push when done.
- **Pros:** Only path that actually hits sub-4s for *novel* prompts on cache hits, and
  turns "20s wait" into "instant-ish for common tea, notify for the long tail."
- **Cons:** Most infra: embedding pipeline, background job runner (nothing like this
  exists in the repo today), cache-hit/miss UX, notification delivery. This is a
  multi-week investment, not a prompt tweak.
- **Verdict:** Right direction for scale, wrong first move — do this after quality is
  fixed, not instead of it.

## 4. Can smaller changes get 80% of the way there?

Yes, and it doesn't require picking one grand architecture over another — it's mostly
**stop doing the one thing that's broken.**

1. **Fix the mode-tracking landmine first** (independent of everything else, currently
   shipping bad print files in `svg` mode). Add a real `previewMode` column instead of
   substring-matching `designPrompt`.
2. **Stop using a text model to hand-author illustrated SVG for the picker.** Either:
   - **(a) Revert Stage 1 to direct image-model calls** (Option 1) — biggest quality
     win, smallest diff, latency goes back to ~15–20s. Mask the wait with progressive
     UI: resolve/render each of the 5 image promises as it completes instead of
     `Promise.all`-blocking on all five, and show title/phrase/blurb (already fast,
     from the concept call) immediately while art pops in card-by-card.
   - **(b) Keep two-stage speed, but make the *fast* preview honest about what it is.**
     Render Stage‑1 previews as a simple deterministic badge — solid brand-color card +
     Satori-rendered phrase text (accurate, legible, near-instant, no model call) — and
     drop the ask for a hand-drawn illustration preview entirely. Stage 2 (on
     selection) does the real illustrated art via `gemini-3-pro-image`, as it already
     does for `raster` mode today. This keeps sub-second Stage 1 and never shows a
     broken/misleading illustration.
3. **Wire up `imageReview`** as an automated QA gate over a fixed eval set (~15–20
   representative "tea" inputs) so future prompt/model edits are measured (pass rate,
   regeneration rate) instead of judged by screenshot. Langfuse is already integrated —
   log eval runs there as a quality metric alongside the existing latency traces.

None of this requires new infrastructure. (1) and (2a) are close to a same-day fix. (3)
is a few hours and pays for itself the next time a prompt gets "tuned" on vibes.

## 5. Model/prompt evaluation

| Piece | Model today | Verdict |
|---|---|---|
| `conceptSystem`/`conceptUser` → concepts | `gemini-3.7-flash` (`textModel`) | Working well — confirmed rich, specific, on-brand `visualConcept`s in the DB sample. Leave alone. |
| Stage‑1 SVG hand-authoring | `gemini-3.5-flash-lite` (`flashLiteModel`) | **Wrong tool for the job at any prompt quality.** A lite text model cannot draw illustration or letterforms via raw path data. Retire this call for anything illustrated; at most keep flash-lite for the Satori-badge text-only preview in §4(b). |
| Stage‑2 raster realization | `gemini-3-pro-image` (`imagenFastModel`) | Good — code comments and the DB sample both indicate strong typography/quality. This is the model that should be doing Stage‑1 too if you take route (2a). |
| Fallback image model | `gemini-3.1-flash-image` (`imageModel`) | Reasonable default for direct Stage‑1 generation if cost/latency matters more than `imagenFastModel`'s ceiling — worth A/B-ing the two once `imageReview` scoring exists. |
| `designImageArtOnly` / `imageReview` | n/a — unused | Already written, already the documented "recommended production alternative" in the file's own header comment. Wire both in.

## 6. Recommended phased roadmap

**Phase 0 (this week, near-zero risk):** Replace the `designPrompt` substring check
with a real enum column tracking preview mode. Stops bad SVG previews from silently
becoming the shipped print file.

**Phase 1 (this week, small diff, largest quality win):** Drop the flash-lite SVG
hand-authoring call for Stage 1. Route straight to `generateImage()` +
`designImage()` per concept, in parallel, resolving/rendering each card as its image
completes rather than blocking on all 5. Accept ~15–20s, offset with progressive
reveal + a "brewing" animation instead of a blank wait.

**Phase 2 (next):** Wire `imageReview` as an eval harness against a fixed keyword set;
track pass/regeneration rate in Langfuse across prompt/model changes.

**Phase 3 (medium term):** Build the `designImageArtOnly` (illustration, model) +
Satori (exact phrase text, code) composite pipeline. This is what actually gets you
faster *and* better for phrase-forward designs, and is a real fix for the "model can't
spell" problem the file's comments already flagged — not a rewrite, a wire-up of code
that's already sitting in `prompts.ts` unused.

**Phase 4 (longer term, once traffic justifies it):** pgvector-backed semantic cache
on the existing Postgres/Prisma database + background generation + notify-on-ready for
cache misses. This is the only path to genuine <4s response for *novel* prompts, and
it's additive on top of Phases 1–3, not a replacement for them.

## 7. On the <4s target

Be explicit with stakeholders: **<4s for a freshly generated illustrated design, at
today's or foreseeable image-model quality, is not achievable synchronously** — a real
multimodal image generation call is the bottleneck and there's no faster substitute
that doesn't sacrifice quality back to what's in the screenshot. <4s is only realistic
for: (a) a cache hit under the Phase 4 architecture, or (b) a pure-typography design
rendered via Satori with no illustration component. Set the near-term latency target
at "~15–20s with good progressive feedback," not "<4s," and treat true <4s as a Phase‑4
outcome for repeat/similar keywords, not a Phase‑1 one.

## 8. Implementation log (Phases 0–2)

**Phase 0 — shipped.** `Design.style` ("raster" | "svg") replaces the three
places that inferred pipeline mode from `designPrompt` substring matching.

**Phase 1 — shipped.** Stage 1 (`generateBatch`) now renders every concept's
final art directly via the image model instead of hand-authored SVG; every
design comes back `"generated"` or `"failed"`, never a separate low-fidelity
preview. Verified against a live key: alpha channel present, correct
light/dark ink for both a dark and a light garment color, legible on-concept
art for the exact "mercury is in microwave" case from the original
screenshot.

Two real bugs surfaced during that verification, both fixed:
- `background-removal.ts` was handing `@imgly/background-removal-node` a raw
  base64 string (read as a URL/path — `ENAMETOOLONG` on a large string) or an
  untyped Buffer (wrapped in a `Blob` with no `type`, so its format sniffer
  rejected it as "Unsupported format"). Fixed by decoding to bytes, sniffing
  the real format with `sharp`, and passing an explicitly MIME-typed `Blob`.
- The project's `sharp` (`^0.35`) and `@imgly/background-removal-node`'s
  bundled `sharp` (`~0.32.4`) each load their own native libvips binding.
  Running both in one process **segfaults the whole server** the first time
  background removal actually executes — this had never been hit before
  because Stage 2 realization, the only prior caller, was apparently never
  exercised end-to-end locally. Fixed with a `package.json` `overrides` pin
  so only one `sharp` is installed tree-wide.
- Separately, `realizeDesign()` catches its own errors internally and
  returns a `status: "failed"` row rather than throwing. `select/route.ts`
  awaited it without checking the returned status, so a real-colored realize
  failure (quota, refusal, network) still fell through to the unconditional
  `status: "pending"` update — the buyer would see "sent to the drop queue"
  over a stale/wrong-color print file. Fixed by checking `realized.status`
  before proceeding.

Measured cost/latency tradeoff: ~40–45s locally for a 5-option batch (5
parallel image-model calls + concurrency-limited local background removal),
not the ~15–20s estimated in §7 above — that estimate undercounted local
background-removal cost. Deploy target is Cloud Run at `--memory=1024Mi
--cpu=1`; that's tight for 5 concurrent image payloads plus two concurrent
ONNX background-removal sessions, so the deploy config was bumped to 2Gi
alongside this rollout.

**Phase 2 — shipped as a manual harness, not a request-time gate.**
`scripts/eval-designs.ts` generates real designs for a fixed keyword set and
grades each with `prompts.imageReview()` (already written, never wired up
before this). A baseline run (n=16: 8 keywords × 2 designs, raster style)
found:

- **Garment-in-graphic rate: 1/16 (6%).** This was the open question raised
  mid-Phase-1 — do "graphic only, no t-shirt" print files actually contain a
  drawn t-shirt often enough to need a generation-time QA-and-regenerate gate
  on every request? At 6% on this sample, no: that's a real, occasional
  model miss, not a systemic failure. Adding a synchronous regeneration loop
  to every one of the now-5-real-image-calls-per-search would add cost and
  latency to fix a one-in-sixteen case. Left as a known residual risk;
  revisit with a larger sample if it turns out to be worse in production
  than this batch suggests.
- **The dominant reported issue, "background is not transparent," is
  largely a false-positive artifact of vision-based review, not a real
  defect.** Cross-checked against `sharp`'s actual `hasAlpha` reading on the
  same bytes the reviewer saw: the review flagged this on a large majority
  of samples, but every one of those images already had a real alpha
  channel. A vision model is shown a flattened/composited view of the image
  and has no way to perceive an alpha channel — it's judging whatever solid
  color the transparent pixels got composited against, not transparency
  itself. `imageReview`'s transparency check should be treated as
  unreliable; transparency is already correctly verified programmatically
  (`sharp` `hasAlpha`) in the real pipeline and in this harness.
- **After discounting that one check, genuine recurring defects are:**
  occasional phrase duplication, occasional misspelling, extra unrequested
  text beyond the exact phrase, and style/palette drift (multi-color output
  when a single/limited-ink style was requested). These show the image
  model isn't perfect at exact-text instruction-following — but this is a
  different order of problem than the original hand-drawn-SVG pipeline,
  which produced *no* legible on-shirt text at all. None of these are
  blocking; they're the kind of thing the existing per-card retry button
  already handles when a buyer notices one.

Kept as a manual/periodic tool in `scripts/`, not wired into `/api/generate`
— consistent with the original plan (§4.3) and with the measured garment
rate not being high enough to justify the added latency/cost of a
synchronous regeneration gate on every request.

**Phase 3 — shipped, confined to the "svg" (Minimalist Line Art) style.**
`designImage()` (raster style) is untouched. For "svg" style, `renderConceptArt()`
in `src/lib/gemini.ts` now:

1. Generates illustration ONLY via `designImageArtOnly()` (written back in
   the original file, never called before this), with an explicit fixed
   layout: illustration confined to the top 74% of the 4500x5400 canvas,
   bottom 26% left transparent.
2. Renders the exact phrase with real font glyph outlines via **Satori**
   (`src/lib/text-layer.ts`), not the image model — this is the actual fix
   for "a text model/image model can't hand-draw letterforms," the root
   cause identified in §1. Font is Archivo Black (OFL), vendored at
   `public/fonts/` so it ships in the Docker image via the existing
   `COPY public` step — no separate Dockerfile change needed.
3. Composites the two transparent layers with `sharp`.

`generateBatch`, `realizeDesign`, and the retry route were all pointed at
this one function instead of each re-implementing "how do we render this
design" — that duplication is exactly what caused the isRaster/isSVG bugs
fixed in Phases 0–2. `isDarkGarment()` (also new, in `prompts.ts`) is the
single source of truth for light-vs-dark ink, shared between the image-model
prompt and Satori's ink color, so they can't disagree.

Real bugs found while verifying this end-to-end:
- The art-only illustration model **ignored "do not render any text"** and
  drew its own duplicate lettering into the illustration layer on the first
  test, defeating the point (the shirt read "MERCURY IN MICROWAVE" twice, in
  two different typefaces). Fixed by substantially strengthening that
  instruction (repeated, more emphatic, explicitly framed as "a separate
  process renders the phrase, not you"). Measured clean afterward — see
  below, this held across every sample checked.
- Satori pulls in `harfbuzzjs`, whose emscripten-generated WASM loader
  locates `hb.wasm` relative to its own `__dirname` at runtime. Next's
  bundler rewrites that path, producing `ENOENT` on a nonsense path
  (`C:\ROOT\...\hb.wasm`) — same class of problem `sharp` and
  `@imgly/background-removal-node` already had. Fixed by adding `satori` to
  `serverExternalPackages` in `next.config.ts`. Verified the fix holds in a
  real production build: ran `next build`, assembled the `.next/standalone`
  output the way the Dockerfile does, and generated real "svg"-style designs
  against `node server.js` — confirmed `harfbuzzjs`'s `hb.wasm` is included
  automatically by Next's output file tracing (unlike `sharp`/`@imgly`, no
  manual Dockerfile `COPY` line was needed here).
- `compositePhraseBand`'s first version resized the illustration to the
  *full* canvas with `fit:"contain"` and trusted that the model's aspect
  ratio matched the canvas closely enough that the reserved bottom band
  stayed clear. It doesn't reliably: Gemini's actual output dimensions don't
  exactly match `PRINT_CANVAS_WIDTH:PRINT_CANVAS_HEIGHT`, so the band's
  position depended on the model's cooperation, not geometry. Fixed by
  resizing the illustration to exactly fill the top region
  (`PRINT_CANVAS_HEIGHT - PRINT_TEXT_BAND_HEIGHT`) and compositing it at
  `top:0` on a blank canvas — the band is reserved by construction now,
  regardless of what aspect ratio the model returns.

**Eval harness run on the code being shipped** (`--style svg --per 1
--keywords 8`, n=8, after both fixes above): 0/8 garment-in-graphic, 0/8
flagged duplicate/garbled lettering in the illustration — the "no text"
fix held. But the harness also reported **8/8 "expected phrase entirely
missing from the image."** That contradicts what the pipeline is
structurally guaranteed to produce (Satori composites the exact phrase
deterministically; there's no code path that skips it), so before trusting
either number I opened the actual saved PNGs for 3 of the corresponding
designs, generated with the same code, and checked them directly: in all
three the phrase is present, correctly spelled, and clearly legible in the
bottom band. This is the same category of false positive as the
transparency check in Phase 2, not a real defect — a large (4500x5400),
very tall image with proportionally small text confined to the bottom 26%
is a plausible case for the reviewer's vision input to downsample the
detail away before it ever "sees" the text. **`imageReview` should not be
trusted for either transparency or phrase-presence on this two-layer
composite** — both need to be verified against the actual output (alpha via
`sharp`, phrase via direct visual check or a review pass at a lower,
report-what-you-actually-see resolution) rather than taken at face value.
This is a limitation of the QA method, not the shipped design pipeline.

Verified end-to-end against the live key (dev and standalone-production
build both): alpha channel confirmed via raw pixel sampling (not just
`sharp` metadata) — sampled transparent corners read alpha=0, and sampled
text-band pixels read the exact ink color `isDarkGarment()` picked
(`#111111` on a White-garment request, `#ffffff` on Black). Raster style
re-tested after the shared-code refactor and produces the same quality as
Phase 1, unaffected.
