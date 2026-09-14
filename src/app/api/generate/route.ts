import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { generateConcepts, isTransientProviderError } from "@/lib/gemini";
import { getProvider } from "@/lib/print-provider";
import { settings } from "@/config/settings";
import { prompts } from "@/config/prompts";
import { pickRandomBackLayout } from "@/lib/back-design";
import { langfuse, getTraceId } from "@/lib/langfuse";
import { logger } from "@/lib/logger";
import { friendlyError } from "@/lib/error-messages";
import { ANON_ID_HEADER } from "@/lib/anon-id";
import { getCustomerSession } from "@/lib/auth";
import { designSlug } from "@/lib/slug";
import { embedTexts, toVectorParam } from "@/lib/embeddings";
import { checkGenerateRateLimit } from "@/lib/rate-limit";
import { enqueueDesignRender } from "@/lib/tasks";
import { finalizeDesignRender } from "@/lib/design-render";

/** Run `worker` over `items`, at most `concurrency` at a time — used for the
 * inline-render fallback below (no render queue configured), so a full
 * batch doesn't pile every slow Gemini call onto this one request/container
 * at once. Server-side twin of the same helper KeywordStudio.tsx used to
 * run client-side before rendering moved server-side. */
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

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  keyword: z.string().trim().min(2).max(280),
  // The picker on the landing page sends the product's numeric id (which we
  // set equal to its Printrove subtypeId) — the reliable way to resolve
  // which of our supported categories was chosen. `category`/`productType`
  // are still accepted as free-text labels for prompt-writing/back-compat,
  // but productId is what actually selects the fulfillment config.
  productId: z.number().optional(),
  category: z.string().optional(),
  productType: z.string().optional(),
  style: z.enum(["raster", "svg"]).optional().default("raster"),
});

/** Resolve the picker's productId to one of our supported category keys. */
function resolveCategory(productId?: number): string {
  const match = settings.printrove.products.find(
    (p) => p.enabled && p.subtypeId === productId
  );
  return match?.category ?? "men";
}

// Health check and main generation logic
export async function POST(req: Request) {
  // No rate-limit gate here on purpose: this route only writes text concepts
  // (generateConcepts, a couple of seconds on the cheap flash-lite model) —
  // the free-generation budget guards the paid image-render calls, which
  // live in /api/generate/retry and /api/realize instead.
  let body;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json(
      { error: "Spill something first — give us 2–280 characters of tea." },
      { status: 400 }
    );
  }

  const { keyword, category, productType, style } = body;
  const resolvedCategory = resolveCategory(body.productId);

  const traceId = getTraceId(req);
  const trace = langfuse.trace({
    name: "generate-api",
    id: traceId,
    input: body,
  });

  logger.info(`[Stage 1] Starting generation for keyword: "${keyword}"`, {
    traceId,
    keyword,
    style,
  });

  try {
    const count = settings.optionsPerKeyword;

    // Stage 1a only: fast concept writing (a couple of seconds). Artwork for
    // each concept is rendered by a separate request per design (fired by the
    // client right after this responds) rather than synchronously here —
    // rendering all N images in one request can take 40-70s+, which exceeds
    // Firebase Hosting's unconfigurable ~60s rewrite-proxy timeout and comes
    // back as an HTML 502 the client can't parse as JSON. See the production
    // incident note in design-quality-improvement-plan.md.
    //
    // No `color` here — garment color is no longer a brew-time choice (see
    // prompts.ts's GARMENT_COLOR_CHOICE): the image-generation call itself
    // picks black or white for the strongest ink contrast and self-reports
    // it, resolved by renderConceptArt() once each design's render actually
    // runs (dispatched below) and written to Design.variantColor then —
    // never known at this row-creation point.
    const concepts = await generateConcepts(keyword, count, { style, category, productType }, trace);

    const batchSpan = trace.span({ name: "create-batch-row" });
    const batch = await prisma.batch.create({ data: { keyword } }).catch((err) => {
      batchSpan.end({ level: "ERROR", statusMessage: String(err) });
      throw err;
    });
    batchSpan.end({ output: batch.id });

    const createDesignSpan = trace.span({ name: "create-design-rows" });
    const designs = await Promise.all(
      concepts.map((c) =>
        prisma.design.create({
          data: {
            batchId: batch.id,
            title: c.title,
            phrase: c.phrase,
            visualConcept: c.visualConcept,
            vibe: c.vibe ?? null,
            blurb: c.blurb ?? null,
            backPhrase: c.backPhrase,
            backLayout: pickRandomBackLayout(),
            style,
            designPrompt: prompts.designImage(c),
            // Garment color isn't known yet — the render dispatched below
            // resolves it from the actual art and writes Design.variantColor
            // then (see design-render.ts's renderDesignArtwork).
            productPrompt: `[mockup composite of clean design on tee — color resolved at render time]`,
            designImagePath: "",
            productImagePath: "",
            designPreviewImagePath: "",
            productPreviewImagePath: "",
            category: resolvedCategory,
            status: "generating",
          },
        })
      )
    ).catch((err) => {
      createDesignSpan.end({ level: "ERROR", statusMessage: String(err) });
      throw err;
    });
    createDesignSpan.end({ output: designs.map((d) => d.id) });

    // Dispatch each design's actual artwork render server-side — the whole
    // point being that this no longer depends on the browser staying open.
    // Resolve the caller's rate-limit identity once here; each render
    // re-checks the SAME bucket independently right before it actually spends
    // it (see reevaluateRateLimit in /api/tasks/render-design), so a
    // mid-batch budget exhaustion still degrades to partial success exactly
    // like today's per-design /api/generate/retry call did.
    const dispatchSpan = trace.span({ name: "dispatch-design-renders" });
    const rateLimit = await checkGenerateRateLimit(req);
    const enqueueResults = await Promise.all(
      designs.map(async (d) => {
        try {
          return { id: d.id, queued: await enqueueDesignRender(d.id, rateLimit) };
        } catch (err) {
          logger.error("[Stage 1] Failed to enqueue design-render task", { traceId, designId: d.id, error: err });
          return { id: d.id, queued: false };
        }
      })
    );
    const needsInline = enqueueResults.filter((r) => !r.queued).map((r) => r.id);
    if (needsInline.length > 0) {
      // No render queue configured — only expected in local dev without
      // `gcloud tasks queues create` having been run (production has it
      // auto-provisioned by deploy.yml). Render inline instead, same as
      // enqueueEmail's fallback: awaited, not fire-and-forget, since Cloud
      // Run can suspend CPU once a response is sent. Limited concurrency so
      // a full batch of slow Gemini calls doesn't all land on this one
      // container at once (see KeywordStudio.tsx's old client-side version
      // of this same guard).
      logger.info(`[Stage 1] Rendering ${needsInline.length} design(s) inline — render queue not configured`, {
        traceId,
        batchId: batch.id,
      });
      await runWithConcurrency(needsInline, 2, async (designId) => {
        const design = designs.find((d) => d.id === designId);
        if (!design) return;
        const inlineTrace = langfuse.trace({ name: "generate-inline-render", input: { designId } });
        await finalizeDesignRender(design, inlineTrace, rateLimit);
      });
    }
    dispatchSpan.end({ output: { queued: enqueueResults.filter((r) => r.queued).length, inline: needsInline.length } });

    // Slug + semantic-search embeddings + brew attribution. Wrapped so a
    // failure here (Gemini quota, a bad row) never blocks or fails brewing —
    // this is enrichment, not part of the product. scripts/backfill-designs.ts
    // catches anything left unset. Cheap and fast (a single embedding
    // round-trip, no per-design image work), so it stays inside stage 1's
    // multi-second budget under the ~60s Firebase Hosting proxy ceiling (see
    // design-quality-improvement-plan.md §9) rather than moving to stage 2.
    const enrichSpan = trace.span({ name: "enrich-design-rows" });
    const anonId = req.headers.get(ANON_ID_HEADER);
    const session = await getCustomerSession(req).catch(() => null);
    const createdByUserId = session?.uid ?? null;
    const designSlugs = new Map<string, string>();
    try {
      const conceptTexts = concepts.map((c) => `${c.title}\n${c.phrase}\n${c.visualConcept}`);
      const backPhraseTexts = concepts.map((c) => c.backPhrase ?? null);
      const [keywordVec, ...restVecs] = await embedTexts([
        keyword,
        ...conceptTexts,
        ...backPhraseTexts,
      ]);
      const conceptVecs = restVecs.slice(0, designs.length);
      const backPhraseVecs = restVecs.slice(designs.length);
      const keywordVecParam = keywordVec ? toVectorParam(keywordVec) : null;

      await Promise.all(
        designs.map(async (d, i) => {
          const slug = designSlug(d.title, d.id);
          const conceptVecParam = conceptVecs[i] ? toVectorParam(conceptVecs[i]!) : null;
          const backPhraseVecParam = backPhraseVecs[i] ? toVectorParam(backPhraseVecs[i]!) : null;
          try {
            await prisma.$executeRaw`
              UPDATE "Design"
              SET slug = ${slug},
                  "createdByAnonId" = ${anonId},
                  "createdByUserId" = ${createdByUserId},
                  "keywordEmbedding" = ${keywordVecParam}::vector,
                  "conceptEmbedding" = ${conceptVecParam}::vector,
                  "backPhraseEmbedding" = ${backPhraseVecParam}::vector
              WHERE id = ${d.id}
            `;
            designSlugs.set(d.id, slug);
          } catch (err) {
            logger.error(
              `[Stage 1] Failed to persist slug/embeddings for design ${d.id} (non-fatal)`,
              { traceId, designId: d.id, error: err }
            );
          }
        })
      );
      enrichSpan.end({ output: { slugged: designSlugs.size, total: designs.length } });
    } catch (err) {
      enrichSpan.end({ level: "ERROR", statusMessage: String(err) });
      logger.error("[Stage 1] Failed to embed/slug batch (non-fatal)", { traceId, error: err });
    }

    trace.update({
      output: { batchId: batch.id, designCount: designs.length },
    });

    logger.info(`[Stage 1] Wrote ${designs.length} concepts, artwork pending`, {
      traceId,
      batchId: batch.id,
      count: designs.length,
    });

    return NextResponse.json({
      batchId: batch.id,
      keyword,
      // Strips validationNotes same as GET /api/generate/status — see that
      // route's doc comment: judge/fix verdict text is admin-only, not
      // customer-facing (unset at this point anyway, since validation runs
      // after creation, but kept symmetric with the other customer-facing
      // design payload rather than relying on that).
      designs: designs.map((d) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { validationNotes, ...safe } = d;
        return { ...safe, slug: designSlugs.get(d.id) ?? null };
      }),
      options: getProvider().options(resolvedCategory),
    });
  } catch (err) {
    const transient = isTransientProviderError(err);
    const rawMessage = err instanceof Error ? err.message : "Generation failed.";
    const message = transient
      ? "Our design engine is swamped right now — try again in a moment."
      : friendlyError(rawMessage);
    trace.update({
      tags: ["error"],
      output: { error: rawMessage },
    });
    logger.error(`[Stage 1] Generation failed: ${rawMessage}`, {
      traceId,
      error: err,
    });
    return NextResponse.json({ error: message }, { status: transient ? 503 : 500 });
  }
}
