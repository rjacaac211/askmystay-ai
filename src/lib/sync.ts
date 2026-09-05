/**
 * Incremental embedding sync.
 *
 * Pure of Vite: imported by the SvelteKit app AND by `scripts/seed.ts` under
 * tsx, so it takes its database and embedder as parameters rather than reaching
 * for `$env/*` or `$lib/*`.
 *
 * The point of this module is that a guidebook edit re-embeds ONE section, not
 * the whole property. Embeddings cost money and time; a host who fixes a typo
 * in the wifi section should not pay to re-embed the other eight. The diff is
 * done on a content hash, so "changed" means the embedded text actually
 * differs — not merely that the CMS fired a webhook.
 */
import type { Sql } from './clients.js';
import { hashContent, type ContentSection } from './content.js';

/** Minimal structural type — keeps this module independent of the embeddings provider. */
export interface Embedder {
	embedDocuments(texts: string[]): Promise<number[][]>;
}

export interface ReindexCounts {
	added: number;
	updated: number;
	deleted: number;
	unchanged: number;
	/** How many embedding calls this run actually paid for (added + updated). */
	embedded: number;
}

/**
 * Bring one property's stored chunks in line with `sections`.
 *
 * Idempotent: running it twice with unchanged content is a single SELECT and
 * reports everything as `unchanged`, spending nothing.
 */
export async function reindexProperty(
	sql: Sql,
	embeddings: Embedder,
	propertyId: string,
	sections: ContentSection[]
): Promise<ReindexCounts> {
	// Rows seeded before source_id existed cannot be diffed — they have no
	// identity to match against. Drop them once; the loop below re-adds them
	// with hashes, and every later run is a real diff.
	await sql`
		DELETE FROM guidebook_chunks
		WHERE property_id = ${propertyId} AND source_id IS NULL
	`;

	const existingRows = await sql<{ source_id: string; content_hash: string }[]>`
		SELECT source_id, content_hash
		FROM guidebook_chunks
		WHERE property_id = ${propertyId}
	`;
	const existing = new Map(existingRows.map((r) => [r.source_id, r.content_hash]));

	// The hash covers visibility as well as text. Marking an existing section
	// guest-only changes no words, so hashing content alone would report it
	// `unchanged` and leave the old public row in place.
	const incoming = sections.map((s) => ({
		...s,
		hash: hashContent(`${s.guestOnly ? 'guest' : 'public'}:${s.content}`)
	}));
	const seen = new Set(incoming.map((s) => s.sourceId));

	const toEmbed = incoming.filter((s) => existing.get(s.sourceId) !== s.hash);
	const added = toEmbed.filter((s) => !existing.has(s.sourceId));
	const updated = toEmbed.filter((s) => existing.has(s.sourceId));
	const removed = [...existing.keys()].filter((id) => !seen.has(id));

	// One batched call for everything that actually changed, or none at all.
	const vectors =
		toEmbed.length > 0 ? await embeddings.embedDocuments(toEmbed.map((s) => s.content)) : [];

	await sql.begin(async (tx) => {
		if (removed.length > 0) {
			await tx`
				DELETE FROM guidebook_chunks
				WHERE property_id = ${propertyId} AND source_id IN ${tx(removed)}
			`;
		}

		for (let i = 0; i < toEmbed.length; i++) {
			const s = toEmbed[i];
			await tx`
				INSERT INTO guidebook_chunks (
					property_id, source_id, heading, content, content_hash, guest_only, embedding
				)
				VALUES (
					${propertyId},
					${s.sourceId},
					${s.heading},
					${s.content},
					${s.hash},
					${s.guestOnly ?? false},
					${`[${vectors[i].join(',')}]`}::vector
				)
				ON CONFLICT (property_id, source_id) DO UPDATE SET
					heading      = EXCLUDED.heading,
					content      = EXCLUDED.content,
					content_hash = EXCLUDED.content_hash,
					guest_only   = EXCLUDED.guest_only,
					embedding    = EXCLUDED.embedding
			`;
		}
	});

	return {
		added: added.length,
		updated: updated.length,
		deleted: removed.length,
		unchanged: incoming.length - toEmbed.length,
		embedded: toEmbed.length
	};
}

export function formatCounts(c: ReindexCounts): string {
	return `${c.added} added, ${c.updated} updated, ${c.deleted} deleted, ${c.unchanged} unchanged (${c.embedded} embedded)`;
}
