import { json, error } from '@sveltejs/kit';
import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';

import { getDb } from '$lib/server/db';
import { getEmbeddings } from '$lib/server/models';
import { findProperty } from '$lib/server/properties';
import { fetchStrapiSections } from '$lib/strapi';
import { listingToSection } from '$lib/listing';
import { reindexProperty, formatCounts } from '$lib/sync';

/**
 * Webhook target for the CMS: re-sync one property's embeddings.
 *
 * Strapi fires this on publish/update/delete. The handler pulls the property's
 * current sections and diffs them against what is stored, so the webhook only
 * has to say *that* something changed — working out *what* changed, and paying
 * to embed only that, is this endpoint's job. See src/lib/sync.ts.
 */

/** Length-safe constant-time compare — timingSafeEqual throws on length mismatch. */
function secretMatches(provided: string, expected: string): boolean {
	const a = Buffer.from(provided);
	const b = Buffer.from(expected);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/**
 * Strapi webhooks post `{ event, model, entry }`. A guidebook-section entry
 * carries its parent property, which is the property to reindex; an explicit
 * `propertyId` in the body wins so the endpoint stays callable by hand.
 */
function resolvePropertyId(body: unknown): string | null {
	if (typeof body !== 'object' || body === null) return null;
	const b = body as Record<string, unknown>;

	if (typeof b.propertyId === 'string' && b.propertyId.trim() !== '') {
		return b.propertyId.trim();
	}

	const entry = b.entry as Record<string, unknown> | undefined;
	const property = entry?.property as Record<string, unknown> | undefined;
	if (typeof property?.slug === 'string' && property.slug.trim() !== '') {
		return property.slug.trim();
	}
	// A property entry itself was edited.
	if (typeof entry?.slug === 'string' && entry.slug.trim() !== '') {
		return entry.slug.trim();
	}
	return null;
}

export const POST: RequestHandler = async ({ request }) => {
	const expected = env.REINDEX_SECRET;
	if (!expected) {
		// Refuse rather than defaulting to open: this endpoint spends money and
		// rewrites what the assistant is allowed to say.
		console.error('[api/reindex] REINDEX_SECRET is not set; refusing to run.');
		error(503, 'Reindexing is not configured.');
	}

	const provided = request.headers.get('x-reindex-secret') ?? '';
	if (!secretMatches(provided, expected)) {
		error(401, 'Invalid or missing reindex secret.');
	}

	let body: unknown = {};
	try {
		body = await request.json();
	} catch {
		// A bare POST with no body is fine when propertyId comes from the default.
	}

	const propertyId = resolvePropertyId(body) ?? env.SEED_PROPERTY_ID ?? '';
	if (!propertyId) {
		error(400, 'Could not determine which property to reindex.');
	}

	try {
		const sections = await fetchStrapiSections(
			env.STRAPI_URL ?? 'http://localhost:1337',
			env.STRAPI_API_TOKEN,
			propertyId
		);

		// The listing rides along, exactly as it does in `npm run seed`. Without it
		// a webhook silently deletes the "About This Place" chunk, and the property
		// page goes on saying "2 bedrooms" while the assistant refuses to say how
		// many bedrooms there are. Read from the database rather than disk: the
		// runtime image ships only build/, and the row is the source of truth the
		// catalogue renders from anyway.
		const property = await findProperty(getDb(), propertyId);
		if (property) sections.push(listingToSection(property.listing));

		const counts = await reindexProperty(getDb(), getEmbeddings(), propertyId, sections);
		console.log(`[api/reindex] ${propertyId}: ${formatCounts(counts)}`);

		return json({ propertyId, ...counts });
	} catch (err) {
		console.error('[api/reindex] failed:', err);
		error(500, 'Reindex failed.');
	}
};
