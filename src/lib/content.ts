/**
 * The shape the indexer consumes, and the adapters that produce it.
 *
 * Pure — no I/O, no env, no clients. Imported both by the SvelteKit app and by
 * `scripts/seed.ts` (which runs under tsx, outside Vite), so it must not touch
 * `$env/*` or `$lib/*`.
 *
 * A content SOURCE (markdown file, Strapi, anything later) only has to produce
 * `ContentSection[]`; everything downstream — hashing, diffing, embedding — is
 * source-agnostic.
 */
import { createHash } from 'node:crypto';

import { chunkGuidebook } from './chunk.js';

export interface ContentSection {
	/**
	 * Stable identity of this section within its property, NOT of its text.
	 *
	 * This is what makes an edit read as `updated` rather than `deleted` plus
	 * `added`, so only genuinely changed sections are re-embedded. Derive it
	 * from something that survives a rewrite: the heading for markdown, the
	 * document id for Strapi.
	 */
	sourceId: string;
	heading: string;
	/** The text that actually gets embedded. */
	content: string;
	/**
	 * Only retrievable once a booking is attached. Enforced in the SQL, not the
	 * prompt: content the model never receives cannot be talked out of it.
	 */
	guestOnly?: boolean;
}

/**
 * The property's display name: the guidebook's single `# ` title.
 *
 * The title line IS the name — no suffix, no frontmatter, no separate registry
 * to drift out of sync with the files. `chunkGuidebook` already drops this
 * preamble from the embedded text, so it costs nothing at retrieval time.
 */
export function propertyNameFromMarkdown(markdown: string, fallback: string): string {
	for (const line of markdown.split(/\r?\n/)) {
		const match = /^#\s+(.+?)\s*$/.exec(line);
		if (match && !line.startsWith('##')) return match[1];
	}
	return fallback;
}

/** sha256 of the embedded text — the change detector for incremental sync. */
export function hashContent(content: string): string {
	return createHash('sha256').update(content, 'utf8').digest('hex');
}

function slugify(heading: string): string {
	return heading
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/**
 * Markdown source: one section per `## ` heading, reusing the existing chunker.
 *
 * The heading slug is the identity, so rewording a section's body is an update
 * while renaming its heading is a delete plus an add. That is the right
 * trade-off for a file where headings are the stable structure.
 */
export function sectionsFromMarkdown(markdown: string): ContentSection[] {
	return chunkGuidebook(markdown).map((c) => ({
		sourceId: `md:${slugify(c.heading)}`,
		heading: c.heading,
		content: c.content,
		guestOnly: c.guestOnly
	}));
}
