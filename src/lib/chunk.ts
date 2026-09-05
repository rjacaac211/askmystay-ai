/**
 * Pure guidebook chunking. No I/O, no env, no clients — this module is imported
 * both by the SvelteKit app and by `scripts/seed.ts` (which runs under tsx,
 * outside Vite), so it must not touch `$env/*` or anything Vite-specific.
 */

export interface GuidebookChunk {
	heading: string;
	content: string;
	/**
	 * Withheld from anyone without a confirmed booking.
	 *
	 * Marked in the source with `<!-- guest-only -->` anywhere in the section.
	 * For access credentials — wifi passwords, door and alarm codes — which a
	 * browsing stranger has no business reading off a public listing page.
	 */
	guestOnly: boolean;
}

/** Section-level marker; stripped from the text before embedding. */
const GUEST_ONLY_MARKER = /<!--\s*guest-only\s*-->/gi;

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

		const raw = body.join('\n');
		const guestOnly = GUEST_ONLY_MARKER.test(raw);
		// `test` on a /g regex advances lastIndex; without this reset the next
		// section reads the wrong answer.
		GUEST_ONLY_MARKER.lastIndex = 0;

		// Stripped before embedding: the marker is metadata for us, and leaving it
		// in would put an HTML comment into the model's context.
		const cleaned = raw.replace(GUEST_ONLY_MARKER, '').trim();
		const content = `## ${heading}\n\n${cleaned}`.trim();

		// Skip headings with no body underneath them.
		if (content !== `## ${heading}`) {
			chunks.push({ heading, content, guestOnly });
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
