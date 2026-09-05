/**
 * Strapi content source.
 *
 * Pure of Vite (`scripts/seed.ts` imports it under tsx), so the base URL and
 * token arrive as arguments rather than from `$env/*`.
 *
 * Strapi 5 flattens attributes onto the entry — there is no `attributes`
 * wrapper as there was in v4 — and gives every entry a stable `documentId`
 * that survives edits, including a heading rename. That id is the section's
 * identity for incremental sync, which is why a Strapi-backed guidebook diffs
 * more precisely than a markdown one.
 */
import type { ContentSection } from './content.js';

interface StrapiEntry {
	documentId: string;
	heading?: string;
	body?: string;
	order?: number;
	/**
	 * Withheld from conversations with no booking attached.
	 *
	 * The CMS has to model this. Without it a reindex from Strapi silently
	 * republishes every guest-only section as public — the wifi password stops
	 * being withheld the moment a host edits anything, which is a security
	 * regression arriving through a content change.
	 */
	guestOnly?: boolean;
}

interface StrapiListResponse {
	data?: StrapiEntry[];
	meta?: { pagination?: { page: number; pageCount: number } };
}

const PAGE_SIZE = 100;

/**
 * Fetch one property's guidebook sections, ordered.
 *
 * The rendered text is `## Heading\n\nbody` — deliberately identical to what
 * `sectionsFromMarkdown` produces. Both sources therefore embed into the same
 * space, so SIMILARITY_THRESHOLD stays valid whichever one is in use, and a
 * property can be migrated from file to CMS without recalibrating.
 */
export async function fetchStrapiSections(
	baseUrl: string,
	token: string | undefined,
	propertyId: string
): Promise<ContentSection[]> {
	const sections: ContentSection[] = [];
	let page = 1;
	let pageCount = 1;

	do {
		const url = new URL('/api/guidebook-sections', baseUrl);
		url.searchParams.set('filters[property][slug][$eq]', propertyId);
		url.searchParams.set('sort', 'order:asc');
		url.searchParams.set('pagination[page]', String(page));
		url.searchParams.set('pagination[pageSize]', String(PAGE_SIZE));

		const response = await fetch(url, {
			headers: token ? { authorization: `Bearer ${token}` } : {}
		});

		if (!response.ok) {
			throw new Error(
				`Strapi returned ${response.status} ${response.statusText} for ${url.pathname}. ` +
					(response.status === 403 || response.status === 401
						? 'Set STRAPI_API_TOKEN, or give the Public role find/findOne on Guidebook Section.'
						: 'Is Strapi running and seeded?')
			);
		}

		const payload = (await response.json()) as StrapiListResponse;

		for (const entry of payload.data ?? []) {
			const heading = entry.heading?.trim();
			const body = entry.body?.trim();
			// A heading with no body embeds as a bare topic label and pollutes
			// retrieval — the markdown chunker drops these too.
			if (!heading || !body) continue;

			sections.push({
				sourceId: `strapi:${entry.documentId}`,
				heading,
				content: `## ${heading}\n\n${body}`,
				// Visibility is part of the content, not a local decoration: without it a
				// reindex republishes every guest-only section as public.
				guestOnly: entry.guestOnly === true
			});
		}

		pageCount = payload.meta?.pagination?.pageCount ?? 1;
		page += 1;
	} while (page <= pageCount);

	return sections;
}
