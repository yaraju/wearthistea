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
