import type { Sql } from '$lib/clients';

export interface RetrievedChunk {
	content: string;
	similarity: number;
}

export interface SearchResult {
	chunks: RetrievedChunk[];
	/**
	 * True when a guest-only section was excluded that would otherwise have been
	 * returned. The caller uses this to tell the model that a better answer
	 * exists behind a booking, so it can say so instead of a flat "no idea".
	 */
	withheldGuestOnly: boolean;
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
 *
 * `includeGuestOnly` is the access boundary, and it lives HERE rather than in
 * the prompt on purpose. A wifi password that never leaves the database cannot
 * be argued, tricked or injected out of the model; one placed in its context
 * with instructions not to share it is one clever question away from leaking.
 * Same reasoning as the `fallback` node: the cheapest guardrail is not sending
 * the data.
 */
export async function searchChunks(
	sql: Sql,
	propertyId: string,
	queryEmbedding: number[],
	limit = 3,
	includeGuestOnly = false
): Promise<SearchResult> {
	const literal = `[${queryEmbedding.join(',')}]`;

	const rows = await sql<{ content: string; similarity: number; guest_only: boolean }[]>`
		SELECT content,
		       guest_only,
		       1 - (embedding <=> ${literal}::vector) AS similarity
		FROM guidebook_chunks
		WHERE property_id = ${propertyId}
		  AND (${includeGuestOnly} OR guest_only = false)
		ORDER BY embedding <=> ${literal}::vector
		LIMIT ${limit}
	`;

	// Was anything withheld that would have ranked? Asked as a separate, cheap
	// query rather than by over-fetching: it only runs for unattached
	// conversations, and only needs to know whether a row exists.
	let withheldGuestOnly = false;
	if (!includeGuestOnly) {
		const [withheld] = await sql<{ similarity: number }[]>`
			SELECT 1 - (embedding <=> ${literal}::vector) AS similarity
			FROM guidebook_chunks
			WHERE property_id = ${propertyId} AND guest_only = true
			ORDER BY embedding <=> ${literal}::vector
			LIMIT 1
		`;
		const best = rows.length > 0 ? Number(rows[0].similarity) : 0;
		// Only counts as withheld if it would have out-ranked what we did return,
		// so an unrelated guest-only section does not trigger the nudge on every
		// question.
		withheldGuestOnly = withheld !== undefined && Number(withheld.similarity) > best;
	}

	return {
		// numeric columns come back as strings from some pg configurations
		chunks: rows.map((r) => ({ content: r.content, similarity: Number(r.similarity) })),
		withheldGuestOnly
	};
}
