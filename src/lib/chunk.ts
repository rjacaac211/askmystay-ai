/**
 * Pure guidebook chunking. No I/O, no env, no clients — this module is imported
 * both by the SvelteKit app and by `scripts/seed.ts` (which runs under tsx,
 * outside Vite), so it must not touch `$env/*` or anything Vite-specific.
 */

export interface GuidebookChunk {
	heading: string;
	content: string;
}

/**
 * Split a guidebook into one chunk per `## ` section.
 *
 * The leading `# Title` preamble is dropped: it is welcome text, not answerable
 * content, and embedding it competes with real sections at retrieval time. Each
 * chunk keeps its own heading in the text so the embedding carries the topic.
 */
export function chunkGuidebook(markdown: string): GuidebookChunk[] {
	const lines = markdown.split(/\r?\n/);
	const chunks: GuidebookChunk[] = [];

	let heading: string | null = null;
	let body: string[] = [];

	const flush = () => {
		if (heading === null) return;
		const content = `## ${heading}\n\n${body.join('\n').trim()}`.trim();
		// Skip headings with no body underneath them.
		if (content !== `## ${heading}`) {
			chunks.push({ heading, content });
		}
	};

	for (const line of lines) {
		// `## ` exactly — `###` and deeper stay part of their parent section.
		const match = /^##\s+(.+?)\s*$/.exec(line);
		if (match && !line.startsWith('###')) {
			flush();
			heading = match[1];
			body = [];
		} else if (heading !== null) {
			body.push(line);
		}
	}
	flush();

	return chunks;
}
