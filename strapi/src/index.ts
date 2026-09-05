import { readFile, readdir } from 'node:fs/promises';
import { resolve, basename } from 'node:path';

import type { Core } from '@strapi/strapi';

/**
 * The assistant reads this CMS over the public REST API, so the Public role
 * needs find/findOne on both content types. Granting it here rather than in the
 * admin UI keeps a fresh `docker compose up` immediately usable and makes the
 * permission set reviewable in git.
 *
 * Read-only on purpose: nothing outside the admin panel may write content.
 */
const WEBHOOK_NAME = 'askmystay-reindex';

const PUBLIC_ACTIONS = [
	'api::property.property.find',
	'api::property.property.findOne',
	'api::guidebook-section.guidebook-section.find',
	'api::guidebook-section.guidebook-section.findOne'
];

async function grantPublicReadAccess(strapi: Core.Strapi) {
	const publicRole = await strapi
		.query('plugin::users-permissions.role')
		.findOne({ where: { type: 'public' } });

	if (!publicRole) return;

	for (const action of PUBLIC_ACTIONS) {
		const existing = await strapi
			.query('plugin::users-permissions.permission')
			.findOne({ where: { action, role: publicRole.id } });

		if (!existing) {
			await strapi
				.query('plugin::users-permissions.permission')
				.create({ data: { action, role: publicRole.id } });
			strapi.log.info(`[bootstrap] granted public: ${action}`);
		}
	}
}

/**
 * Split the demo guidebook into `## ` sections.
 *
 * Deliberately a small local copy rather than an import of `src/lib/chunk.ts`
 * from the parent app: Strapi is a separate package with its own tsconfig and
 * build, and reaching across that boundary would couple them. This runs ONCE,
 * to put starter content in an empty CMS — it is not part of the indexing path.
 * Retrieval always chunks through the app's own code.
 */
function splitSections(markdown: string): { heading: string; body: string; guestOnly: boolean }[] {
	const out: { heading: string; body: string; guestOnly: boolean }[] = [];
	let heading: string | null = null;
	let body: string[] = [];

	const flush = () => {
		if (heading === null) return;
		const raw = body.join('\n');
		// The same marker the app's chunker looks for. Stripped so it does not end
		// up as literal text in the CMS, but carried through as a field so a
		// reindex keeps the section restricted.
		const guestOnly = /<!--\s*guest-only\s*-->/i.test(raw);
		const text = raw.replace(/<!--\s*guest-only\s*-->/gi, '').trim();
		if (text) out.push({ heading, body: text, guestOnly });
	};

	for (const line of markdown.split(/\r?\n/)) {
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
	return out;
}

async function seedDemoContent(strapi: Core.Strapi) {
	const existing = await strapi.documents('api::property.property').count({});
	if (existing > 0) return;

	// process.cwd() is the Strapi project root in both dev and the built image;
	// __dirname is not (TypeScript compiles this file into dist/). GUIDEBOOK_DIR
	// overrides it in Docker, where the parent repo is not on the filesystem.
	const guidebookDir =
		process.env.GUIDEBOOK_DIR ?? resolve(process.cwd(), '../src/data/guidebooks');

	let files: string[];
	try {
		files = (await readdir(guidebookDir)).filter((f) => f.endsWith('.md')).sort();
	} catch {
		strapi.log.warn(`[bootstrap] no guidebooks at ${guidebookDir}; skipping demo content.`);
		return;
	}

	for (const file of files) {
		// Same convention as the app's seed: the filename is the property_id that
		// scopes retrieval, and the single "# " title is the display name.
		const slug = basename(file, '.md');
		const markdown = await readFile(resolve(guidebookDir, file), 'utf-8');
		const title = /^#\s+(.+?)\s*$/m.exec(markdown.replace(/^##.*$/gm, ''));

		const property = await strapi.documents('api::property.property').create({
			data: { name: title?.[1] ?? slug, slug },
			status: 'published'
		});

		const sections = splitSections(markdown);
		for (const [index, section] of sections.entries()) {
			await strapi.documents('api::guidebook-section.guidebook-section').create({
				data: {
					heading: section.heading,
					body: section.body,
					order: index,
					guestOnly: section.guestOnly,
					property: property.documentId
				},
				status: 'published'
			});
		}

		strapi.log.info(`[bootstrap] seeded "${slug}" with ${sections.length} guidebook sections.`);
	}
}


/**
 * Register the reindex webhook so a fresh stack needs no clicking in the admin
 * UI. Idempotent by name: an operator who edits or disables it in the panel
 * keeps their change across restarts.
 *
 * Skipped unless both env vars are set, so a bare `npm run develop` with no app
 * running does not queue failing deliveries.
 */
async function registerReindexWebhook(strapi: Core.Strapi) {
	const url = process.env.REINDEX_WEBHOOK_URL;
	const secret = process.env.REINDEX_SECRET;
	if (!url || !secret) {
		strapi.log.info('[bootstrap] REINDEX_WEBHOOK_URL/REINDEX_SECRET unset; skipping webhook.');
		return;
	}

	const store = strapi.get('webhookStore');
	const existing = await store.findWebhooks();
	const current = existing.find((w: { name: string }) => w.name === WEBHOOK_NAME);

	const definition = {
		name: WEBHOOK_NAME,
		url,
		headers: { 'x-reindex-secret': secret },
		// Publish/unpublish matter as much as create/update: the assistant reads
		// published content only, so unpublishing a section must drop its vector.
		events: [
			'entry.create',
			'entry.update',
			'entry.delete',
			'entry.publish',
			'entry.unpublish'
		]
	};

	if (!current) {
		await store.createWebhook({ ...definition, isEnabled: true });
		strapi.log.info(`[bootstrap] registered webhook "${WEBHOOK_NAME}" -> ${url}`);
		return;
	}

	// The env var is the source of truth for WHERE it points — the same volume
	// gets reused across `npm run develop` (localhost) and compose (service
	// name), and a stale URL fails silently. `isEnabled` is left alone so an
	// operator who turned it off in the admin panel keeps it off.
	if (current.url !== url || current.headers?.['x-reindex-secret'] !== secret) {
		await store.updateWebhook(current.id, { ...definition, isEnabled: current.isEnabled });
		strapi.log.info(`[bootstrap] updated webhook "${WEBHOOK_NAME}" -> ${url}`);
	}
}

export default {
	register(/* { strapi }: { strapi: Core.Strapi } */) {},

	async bootstrap({ strapi }: { strapi: Core.Strapi }) {
		await grantPublicReadAccess(strapi);
		await seedDemoContent(strapi);
		await registerReindexWebhook(strapi);
	}
};
