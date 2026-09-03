import type { Sql } from '$lib/clients';

export interface RetrievedChunk {
	content: string;
	similarity: number;
}

/**
 * Top-k pgvector cosine search, scoped to one property.
 *
 * `<=>` is cosine DISTANCE (0 = identical, 2 = opposite), so similarity is
 * `1 - distance`. Ordering ascending by distance therefore returns the most
 * similar rows first. Getting this the wrong way round would silently invert
 * the relevance threshold and route good questions to the fallback.
 *
 * The `postgres` driver has no pgvector type, so the embedding is passed as a
 * parameterised pgvector literal and cast with `::vector`.
 */
export async function searchChunks(
	sql: Sql,
	propertyId: string,
	queryEmbedding: number[],
	limit = 3
): Promise<RetrievedChunk[]> {
	const literal = `[${queryEmbedding.join(',')}]`;

	const rows = await sql<{ content: string; similarity: number }[]>`
		SELECT content,
		       1 - (embedding <=> ${literal}::vector) AS similarity
		FROM guidebook_chunks
		WHERE property_id = ${propertyId}
		ORDER BY embedding <=> ${literal}::vector
		LIMIT ${limit}
	`;

	// numeric columns come back as strings from some pg configurations
	return rows.map((r) => ({ content: r.content, similarity: Number(r.similarity) }));
}
