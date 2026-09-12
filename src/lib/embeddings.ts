import { ai } from "./gemini";

/**
 * Gemini's embedding model, truncated to 768 dimensions via
 * outputDimensionality (its native output is 3072-dim — text-embedding-004,
 * the smaller 768-dim model, isn't available on this API key/version;
 * confirmed via a live ListModels call, only gemini-embedding-001 and its
 * "-2" variants support embedContent here). The 768 truncation is load-
 * bearing: the Design.keywordEmbedding/conceptEmbedding/backPhraseEmbedding
 * columns are declared `vector(768)` in prisma/schema.prisma and the HNSW
 * indexes in scripts/setup-pgvector-indexes.ts are built against that width.
 * pgvector's `<=>` cosine-distance operator normalizes internally, so a
 * truncated (non-unit-length) embedding is still fine for similarity search.
 * Changing EMBEDDING_DIM later requires a coordinated column-type change,
 * index rebuild, and full re-embed — not a config flip.
 */
export const EMBEDDING_MODEL = "gemini-embedding-001";
export const EMBEDDING_DIM = 768;

/**
 * Embeds up to N texts in as few round-trips as practical against the
 * existing Gemini client (see gemini.ts's `ai()` singleton — never construct
 * a separate GoogleGenAI client here). A `null` entry in `texts` (e.g. a
 * design with no backPhrase) maps to a `null` entry in the result at the
 * same index — nulls are never dropped/reindexed.
 *
 * Never throws on a provider failure — callers (stage-1 /api/generate,
 * scripts/backfill-designs.ts) must not have brewing blocked by embedding,
 * which is an enhancement, not a requirement. On any failure this logs and
 * returns an all-null array the same length as `texts`.
 */
export async function embedTexts(texts: (string | null)[]): Promise<(number[] | null)[]> {
  const indices: number[] = [];
  const nonNullTexts: string[] = [];
  texts.forEach((t, i) => {
    if (t !== null && t.trim() !== "") {
      indices.push(i);
      nonNullTexts.push(t);
    }
  });

  const result: (number[] | null)[] = new Array(texts.length).fill(null);
  if (nonNullTexts.length === 0) return result;

  try {
    const response = await ai().models.embedContent({
      model: EMBEDDING_MODEL,
      contents: nonNullTexts,
      config: { outputDimensionality: EMBEDDING_DIM },
    });
    const embeddings = response.embeddings ?? [];
    indices.forEach((originalIndex, j) => {
      const values = embeddings[j]?.values;
      if (values && values.length === EMBEDDING_DIM) {
        result[originalIndex] = values;
      }
    });
  } catch (err) {
    console.error("[embeddings] embedTexts failed, returning nulls:", err);
  }

  return result;
}

/** Convenience for a single string — used to embed a search query. */
export async function embedText(text: string): Promise<number[] | null> {
  const [vec] = await embedTexts([text]);
  return vec;
}

/**
 * Formats a vector for a raw SQL parameter, e.g.:
 *   prisma.$executeRaw`UPDATE "Design" SET "keywordEmbedding" = ${toVectorParam(v)}::vector WHERE id = ${id}`
 * Never build the vector literal via string interpolation into
 * queryRawUnsafe/executeRawUnsafe — always pass it as a bound parameter with
 * the ::vector cast applied in the query text, as above.
 */
export function toVectorParam(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
