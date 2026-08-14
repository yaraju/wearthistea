---
sessionId: session-260815-005607-wyzm
---

# Requirements

### Overview & Goals
The current image generation pipeline via Gemini 2.5 Flash is experiencing high latency (~30s for Raster, ~50s for SVG), which degrades the user experience during the "Spill the Tea" workflow. This plan replaces the bottleneck components with a **two-stage pipeline**:
1.  **Stage 1 (Instant)**: Generate 5 concepts and minimalist SVG previews using Gemini 2.5 Flash Lite (<1s).
2.  **Stage 2 (Realization)**: Defer high-quality PNG generation (Imagen 4 Fast) and background removal (@imgly local library) to a final preview/refinement step.
This ensures sub-second initial feedback while maintaining print quality and reducing costs.

### Scope
- **In Scope**:
  - Integration of Gemini 2.5 Flash Lite for instant multi-mode concept + SVG generation.
  - Deferred integration of Google Imagen 4 Fast for Raster images.
  - Deferred transparent background removal for Raster designs (via local library).
  - Implementation of a "Finalization" API call to realize the design for printing.
  - Alignment strategy to ensure Raster output matches the SVG concept layout.
- **Out of Scope**:
  - Changes to the frontend UI layout (beyond handling the two-stage state).
  - Changes to the Printify/PrintRove fulfillment logic.
  - Implementation of local LLMs for text.

### Functional Requirements
- **Initial Latency**: Total time for 5 generated "concept" options must be < 2 seconds.
- **Realization Latency**: Final high-res PNG + Background removal must be < 5 seconds.
- **Transparency**: Final Raster images must have a transparent alpha channel for printing.
- **Alignment**: The final Raster design must maintain the spatial composition (text placement, icon position) of the SVG preview.

# Technical Design

### Current Implementation
The current pipeline in `src/lib/gemini.ts` uses:
- `gemini-2.5-flash` for all text and SVG generation.
- `gemini-2.5-flash-image` for raster images.
The bottleneck is Gemini's multimodal response time and sequential processing of large SVG batches.

### Key Decisions
- **Deferred Heavy Processing**: By moving Imagen 4 Fast and Background Removal to a "Second Stage" (triggered when a user clicks a design), we reduce the time-to-first-design from 30s to <1s.
- **SVGs as Universal Previews**: Both "Raster" and "SVG" modes will initially generate minimalist SVGs. For Raster mode, these act as "wireframes" or "sketches".
- **Local Background Removal**: Using `@imgly/background-removal-node` locally saves cost and network overhead during the final realization stage.
- **Alignment via Spatial Prompts**: To prevent alignment issues between the SVG preview and the Raster final, the Imagen prompt will include explicit spatial markers (e.g., "Graphic in top-left, large text in center") derived from the SVG's structure.

### Proposed Architecture
```mermaid
graph TD
    API[/api/generate] --> Lite[Gemini 2.5 Flash Lite]
    Lite -- 5 Concepts + SVGs --> UI[Browser Preview]
    UI -- User Selects Design --> Realize[/api/realize]
    Realize --> Mode{Style?}
    Mode -- Raster --> Img[Imagen 4 Fast]
    Img --> BG[Local BG Remover]
    BG -- Transparent PNG --> Final[Final Design]
    Mode -- SVG --> Sharp[Sharp Rasterizer]
    Sharp -- High-Res PNG --> Final
    Final --> Storage[Cloud Storage]
```

### File Structure
- `src/lib/background-removal.ts`: Wrapper for the local `@imgly` library.
- `src/lib/ai-service.ts`: Orchestrator (replacing/wrapping `gemini.ts`).
- `src/config/settings.ts`: New settings for `AI_IMAGE_PROVIDER` and `AI_TEXT_PROVIDER`.

# Testing

### Validation Approach
Verification will focus on latency benchmarks and output quality (transparency and print resolution).

### Key Scenarios
- **Raster Generation**: Verify that a keyword search returns 5 designs in < 8s. Inspect the generated PNGs for transparency (black/white background test).
- **SVG Generation**: Verify that the "Minimalist" mode returns 5 designs in < 4s. Confirm the SVGs are valid by checking the mockup render.
- **Fallback**: Temporarily disable Imagen/Lite model support to ensure the system falls back to Gemini 1.5 without crashing.

### Edge Cases
- **Imagen Safety Filters**: Implement retries or fallbacks for prompts that trigger Google's safety filters (even if innocent).
- **BG Removal Performance**: Monitor CPU spikes during parallel background removal; implement a queue if server stability is compromised.
- **Malformed SVG**: Add a regex check to ensure Gemini-generated SVGs are wrapped in `<svg>` tags before passing to `sharp`.
- **API Rate Limits**: Ensure parallel calls stay within account limits.

# Delivery Steps

### ✓ Step 1: Implement Instant Multi-Mode SVG Batching
Enable near-instant generation of concepts and vector previews.
- Update `src/lib/gemini.ts` to use `gemini-2.5-flash-lite` for all initial batch requests.
- Modify `generateBatch` to return SVG code for both `raster` and `svg` modes (Raster SVGs act as wireframes).
- Update the API route to return these minimalist previews immediately, delaying high-res generation.

### ✓ Step 2: Implement Deferred Realization and Background Removal
Build the engine for converting concepts into print-ready designs on-demand.
- Create `src/lib/background-removal.ts` using `@imgly/background-removal-node`.
- Implement `src/lib/realize.ts` which takes a concept ID and generates the final high-res output (Imagen 4 Fast for Raster, Sharp for SVG).
- Add "Spatial Mapping" logic to the Imagen prompt generator to ensure the final PNG aligns with the SVG preview's text and graphic placement.

### ✓ Step 3: Unified AI Service and Route Optimization
Expose the two-stage pipeline to the application.
- Create `src/app/api/realize/route.ts` to handle the second-stage heavy processing.
- Refactor `src/app/api/generate/route.ts` to only perform the Stage 1 fast generation.
- Add performance logging to measure the latency reduction for the initial search.