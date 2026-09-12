import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { embedText, toVectorParam } from "./embeddings";

export type EmbeddingField = "keyword" | "concept" | "backPhrase";

const COLUMN_BY_FIELD: Record<EmbeddingField, string> = {
  keyword: "keywordEmbedding",
  concept: "conceptEmbedding",
  backPhrase: "backPhraseEmbedding",
};

const ALL_FIELDS: EmbeddingField[] = ["keyword", "concept", "backPhrase"];

export interface SearchHit {
  designId: string;
  distance: number; // cosine distance, 0 = identical, lower is better
  matchedField: EmbeddingField;
}

export interface SearchOptions {
  limit: number;
  fields?: EmbeddingField[]; // default: all three
  excludeDesignIds?: string[];
  onlyStatus?: string; // e.g. "generated"
  excludeAllRejected?: boolean; // drop designs where every DesignProduct combo is rejected
}

/**
 * Core ANN query: one CTE per (field, vector) pair, each independently
 * hitting that column's HNSW index via `ORDER BY col <=> $vec LIMIT innerK`
 * — critical to get right, since a naive `ORDER BY LEAST(a<=>q, b<=>q, ...)`
 * across columns defeats every index with a full table scan. innerK is
 * 4-5x the final limit because post-filtering (status/approval/excluded
 * ids) happens after ranking, in the outer query, never inside these CTEs
 * (filtering before ranking could exclude the true nearest neighbor).
 */
async function runAnnQuery(
  pairs: Array<{ field: EmbeddingField; vector: number[] }>,
  options: SearchOptions
): Promise<SearchHit[]> {
  if (pairs.length === 0) return [];

  const innerK = Math.max(options.limit * 5, 50);

  const cteFragments = pairs.map(({ field, vector }) => {
    const column = COLUMN_BY_FIELD[field];
    const vecParam = toVectorParam(vector);
    // Parenthesized: Postgres requires each UNION arm that carries its own
    // ORDER BY/LIMIT to be wrapped, otherwise LIMIT is parsed as belonging
    // to the outer UNION and this is a syntax error.
    return Prisma.sql`(
      SELECT id, "${Prisma.raw(column)}" <=> ${vecParam}::vector AS distance, ${field} AS field
      FROM "Design"
      WHERE "${Prisma.raw(column)}" IS NOT NULL
      ORDER BY "${Prisma.raw(column)}" <=> ${vecParam}::vector
      LIMIT ${innerK}
    )`;
  });

  const filters: Prisma.Sql[] = [];
  if (options.onlyStatus) {
    filters.push(Prisma.sql`d.status = ${options.onlyStatus}`);
  }
  if (options.excludeDesignIds && options.excludeDesignIds.length > 0) {
    filters.push(Prisma.sql`m.id NOT IN (${Prisma.join(options.excludeDesignIds)})`);
  }
  if (options.excludeAllRejected) {
    filters.push(Prisma.sql`(
      NOT EXISTS (SELECT 1 FROM "DesignProduct" dp WHERE dp."designId" = m.id)
      OR EXISTS (SELECT 1 FROM "DesignProduct" dp WHERE dp."designId" = m.id AND dp."approvalStatus" <> 'rejected')
    )`);
  }
  const whereClause =
    filters.length > 0 ? Prisma.sql`WHERE ${Prisma.join(filters, " AND ")}` : Prisma.empty;

  const query = Prisma.sql`
    WITH unioned AS (
      ${Prisma.join(cteFragments, " UNION ALL ")}
    ),
    merged AS (
      SELECT DISTINCT ON (id) id, distance, field
      FROM unioned
      ORDER BY id, distance ASC
    )
    SELECT m.id AS "designId", m.distance AS "distance", m.field AS "matchedField"
    FROM merged m
    JOIN "Design" d ON d.id = m.id
    ${whereClause}
    ORDER BY m.distance ASC
    LIMIT ${options.limit}
  `;

  return prisma.$queryRaw<SearchHit[]>(query);
}

/**
 * Embeds `queryText` once and runs one ANN query per requested column (all
 * three by default), each independently hitting its own HNSW index, merged
 * by minimum distance per design. Used for: pre-brewed matching (the new
 * brew's keyword against past designs' keywordEmbedding), admin catalog
 * semantic search, and the LLM-judge search endpoint.
 */
export async function searchDesignsByText(
  queryText: string,
  options: SearchOptions
): Promise<SearchHit[]> {
  const vec = await embedText(queryText);
  if (!vec) return [];
  const fields = options.fields ?? ALL_FIELDS;
  return runAnnQuery(fields.map((field) => ({ field, vector: vec })), options);
}

/**
 * Same ANN core, but takes a design's own stored embeddings as the query —
 * no re-embedding a string. Each provided vector is compared only against
 * its own corresponding column (a keyword vector against keywordEmbedding,
 * not against conceptEmbedding), unlike searchDesignsByText which compares
 * one vector against every requested column. Used for "similar designs"
 * (account page) and admin "find similar" tooling.
 */
export async function searchDesignsByVectors(
  vectors: { keyword?: number[] | null; concept?: number[] | null; backPhrase?: number[] | null },
  options: SearchOptions
): Promise<SearchHit[]> {
  const requestedFields = new Set(options.fields ?? ALL_FIELDS);
  const pairs: Array<{ field: EmbeddingField; vector: number[] }> = [];
  for (const field of ALL_FIELDS) {
    const vec = vectors[field];
    if (vec && requestedFields.has(field)) pairs.push({ field, vector: vec });
  }
  return runAnnQuery(pairs, options);
}

/** Raw-SQL fetch of a Design's own three embeddings (for "similar designs"). */
export async function getDesignEmbeddings(
  designId: string
): Promise<{ keyword: number[] | null; concept: number[] | null; backPhrase: number[] | null } | null> {
  const rows = await prisma.$queryRaw<
    Array<{ keyword: string | null; concept: string | null; backPhrase: string | null }>
  >`
    SELECT "keywordEmbedding"::text AS keyword,
           "conceptEmbedding"::text AS concept,
           "backPhraseEmbedding"::text AS "backPhrase"
    FROM "Design"
    WHERE id = ${designId}
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    keyword: parsePgVectorText(row.keyword),
    concept: parsePgVectorText(row.concept),
    backPhrase: parsePgVectorText(row.backPhrase),
  };
}

function parsePgVectorText(text: string | null): number[] | null {
  if (!text) return null;
  return text
    .slice(1, -1) // strip surrounding [ ]
    .split(",")
    .map(Number);
}
