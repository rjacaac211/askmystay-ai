/**
 * Idempotent seed: create the schema, sync every property's embeddings, and load
 * the fixture bookings. A fresh database needs only this script.
 *
 * Runs under tsx, OUTSIDE Vite — so the `$env/*` aliases do not resolve here.
 * It reads process.env (via dotenv) and calls the same factory functions the
 * app uses, sharing the chunker and the indexer verbatim.
 *
 * Every `src/data/guidebooks/<property-id>.md` file is one property: the
 * filename is the property_id that scopes retrieval, and the single `# ` title
 * is the display name. No separate registry to drift out of sync with the files.
 *
 * The content source is pluggable:
 *
 *   npm run seed                     # markdown (default) — no Strapi needed
 *   npm run seed -- --source=strapi  # pull sections from the CMS instead
 *   npm run seed -- --property=x     # just one property
 *
 * The markdown path is kept working on purpose: the repo has to run end-to-end
 * for someone who does not want to boot a CMS just to read the code.
 */
import 'dotenv/config';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';

import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

import {
	sectionsFromMarkdown,
	propertyNameFromMarkdown,
	type ContentSection
} from '../src/lib/content.js';
import { reindexProperty, formatCounts } from '../src/lib/sync.js';
import { fetchStrapiSections } from '../src/lib/strapi.js';
import { parseListing, listingToSection, type PropertyListing } from '../src/lib/listing.js';
import { BOOKING_FIXTURES, offsetDate } from '../src/data/bookings.js';

import { createDb, createEmbeddings, EMBEDDING_DIMENSIONS } from '../src/lib/clients.js';

const here = dirname(fileURLToPath(import.meta.url));
const GUIDEBOOK_DIR = resolve(here, '../src/data/guidebooks');
const LISTING_DIR = resolve(here, '../src/data/properties');

const SOURCE = (process.argv.find((a) => a.startsWith('--source='))?.split('=')[1] ??
	'markdown') as 'markdown' | 'strapi';

/** Limit the run to one property. SEED_PROPERTY_ID stays supported for compatibility. */
const ONLY = process.argv.find((a) => a.startsWith('--property='))?.split('=')[1] ??
	process.env.SEED_PROPERTY_ID;

interface PropertyContent {
	propertyId: string;
	name: string;
	listing: PropertyListing;
	sections: ContentSection[];
}

/**
 * Listing details for a property, or sensible blanks.
 *
 * A property with a guidebook but no listing file still works — it just has a
 * thin catalogue entry. Retrieval never depends on this.
 */
async function loadListing(propertyId: string, fallbackName: string): Promise<PropertyListing> {
	try {
		const raw = await readFile(resolve(LISTING_DIR, `${propertyId}.json`), 'utf-8');
		return parseListing(JSON.parse(raw), fallbackName);
	} catch {
		return parseListing({}, fallbackName);
	}
}

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		console.error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
		process.exit(1);
	}
	return value;
}

async function loadFromMarkdown(): Promise<PropertyContent[]> {
	const files = (await readdir(GUIDEBOOK_DIR)).filter((f) => f.endsWith('.md')).sort();
	const out: PropertyContent[] = [];

	for (const file of files) {
		const propertyId = basename(file, '.md');
		if (ONLY && propertyId !== ONLY) continue;

		const markdown = await readFile(resolve(GUIDEBOOK_DIR, file), 'utf-8');
		const name = propertyNameFromMarkdown(markdown, propertyId);
		const listing = await loadListing(propertyId, name);

		out.push({
			propertyId,
			name: listing.name || name,
			listing,
			// The listing rides along as one more retrievable section, so the
			// assistant can answer anything the catalogue page states.
			sections: [...sectionsFromMarkdown(markdown), listingToSection(listing)]
		});
	}
	return out;
}

async function loadFromStrapi(): Promise<PropertyContent[]> {
	const url = process.env.STRAPI_URL ?? 'http://localhost:1337';
	console.log(`Fetching from Strapi at ${url}`);

	// Strapi is the source of the property list too, so the two stay consistent.
	const response = await fetch(new URL('/api/properties?pagination[pageSize]=100', url), {
		headers: process.env.STRAPI_API_TOKEN
			? { authorization: `Bearer ${process.env.STRAPI_API_TOKEN}` }
			: {}
	});
	if (!response.ok) {
		throw new Error(`Strapi returned ${response.status} listing properties. Is it running?`);
	}

	const payload = (await response.json()) as { data?: { slug?: string; name?: string }[] };
	const out: PropertyContent[] = [];

	for (const entry of payload.data ?? []) {
		const propertyId = entry.slug?.trim();
		if (!propertyId) continue;
		if (ONLY && propertyId !== ONLY) continue;

		const name = entry.name?.trim() || propertyId;
		// Listing details still come from disk: they are catalogue copy, not
		// guidebook content, and Strapi does not model them.
		const listing = await loadListing(propertyId, name);

		out.push({
			propertyId,
			name: listing.name || name,
			listing,
			sections: [
				...(await fetchStrapiSections(url, process.env.STRAPI_API_TOKEN, propertyId)),
				listingToSection(listing)
			]
		});
	}
	return out;
}

function loadProperties(): Promise<PropertyContent[]> {
	return SOURCE === 'strapi' ? loadFromStrapi() : loadFromMarkdown();
}

async function main() {
	const databaseUrl = requireEnv('DATABASE_URL');
	const apiKey = requireEnv('OPENAI_API_KEY');

	const sql = createDb(databaseUrl);
	const embeddings = createEmbeddings(apiKey);

	console.log('Ensuring schema...');
	await sql`CREATE EXTENSION IF NOT EXISTS vector`;
	await sql`
		CREATE TABLE IF NOT EXISTS guidebook_chunks (
			id          bigserial PRIMARY KEY,
			property_id text NOT NULL,
			content     text NOT NULL,
			embedding   vector(${sql.unsafe(String(EMBEDDING_DIMENSIONS))}) NOT NULL,
			created_at  timestamptz NOT NULL DEFAULT now()
		)
	`;
	// Added after the first release, so ADD COLUMN IF NOT EXISTS rather than a
	// migration framework: `source_id` is the section's stable identity and
	// `content_hash` is the change detector, together making a reindex a diff
	// instead of a full re-embed. See src/lib/sync.ts.
	await sql`ALTER TABLE guidebook_chunks ADD COLUMN IF NOT EXISTS source_id text`;
	await sql`ALTER TABLE guidebook_chunks ADD COLUMN IF NOT EXISTS heading text`;
	await sql`ALTER TABLE guidebook_chunks ADD COLUMN IF NOT EXISTS content_hash text`;
	// Withheld from conversations with no booking attached. Defaults false so
	// existing rows stay public until a reindex says otherwise.
	await sql`ALTER TABLE guidebook_chunks ADD COLUMN IF NOT EXISTS guest_only boolean NOT NULL DEFAULT false`;
	await sql`
		CREATE INDEX IF NOT EXISTS guidebook_chunks_property_id_idx
		ON guidebook_chunks (property_id)
	`;
	// The upsert target for a reindex: one row per section per property.
	await sql`
		CREATE UNIQUE INDEX IF NOT EXISTS guidebook_chunks_property_source_idx
		ON guidebook_chunks (property_id, source_id)
	`;
	// Deliberately no ivfflat/HNSW index on `embedding`: one guidebook is ~10
	// rows, where an exact scan is faster and an ivfflat index built on so few
	// rows measurably degrades recall. Add one when a property set grows large.

	// Gives each property_id a display name, so the UI does not hardcode one.
	await sql`
		CREATE TABLE IF NOT EXISTS properties (
			property_id text PRIMARY KEY,
			name        text NOT NULL,
			created_at  timestamptz NOT NULL DEFAULT now()
		)
	`;
	// Catalogue copy. Stored as one jsonb blob rather than a dozen columns: it is
	// read whole by one page, never queried by field, and adding an amenity
	// should not be a migration.
	await sql`ALTER TABLE properties ADD COLUMN IF NOT EXISTS listing jsonb`;

	// Live stay data. A guidebook answers questions about the PROPERTY; this
	// table answers questions about the STAY ("when do I check out?"), which no
	// amount of retrieval can reach because the fact is not written in any
	// document — it is a row that changes per guest.
	await sql`
		CREATE TABLE IF NOT EXISTS bookings (
			id                     bigserial PRIMARY KEY,
			property_id            text NOT NULL,
			booking_ref            text NOT NULL UNIQUE,
			guest_name             text NOT NULL,
			check_in               date NOT NULL,
			check_out              date NOT NULL,
			unit                   text,
			guest_count            integer NOT NULL DEFAULT 1,
			status                 text NOT NULL DEFAULT 'confirmed',
			late_checkout_approved boolean NOT NULL DEFAULT false,
			notes                  text,
			created_at             timestamptz NOT NULL DEFAULT now()
		)
	`;
	await sql`
		CREATE INDEX IF NOT EXISTS bookings_property_id_idx ON bookings (property_id)
	`;

	// Guest-initiated actions. Separate from `bookings` because a request is not
	// a fact about the stay — it is something the assistant DID, which a host
	// still has to approve. See src/lib/server/actions.ts.
	await sql`
		CREATE TABLE IF NOT EXISTS late_checkout_requests (
			id             bigserial PRIMARY KEY,
			property_id    text NOT NULL,
			booking_ref    text NOT NULL,
			requested_time text,
			status         text NOT NULL DEFAULT 'pending',
			created_at     timestamptz NOT NULL DEFAULT now()
		)
	`;
	await sql`
		CREATE INDEX IF NOT EXISTS late_checkout_requests_booking_idx
		ON late_checkout_requests (property_id, booking_ref)
	`;

	console.log('Ensuring LangGraph checkpoint tables...');
	const checkpointer = PostgresSaver.fromConnString(databaseUrl);
	await checkpointer.setup();
	await checkpointer.end();

	const properties = await loadProperties();
	if (properties.length === 0) {
		console.error(`No properties found from source "${SOURCE}"${ONLY ? ` matching "${ONLY}"` : ''}.`);
		process.exit(1);
	}

	for (const property of properties) {
		console.log(`\n${property.name}  (${property.propertyId})`);

		if (property.sections.length === 0) {
			console.error(`  no sections — skipping`);
			continue;
		}
		for (const s of property.sections) console.log(`  - ${s.heading}`);

		// sql.json(), NOT a stringified literal cast to ::jsonb. The driver already
		// JSON-encodes a parameter bound to a jsonb column, so passing pre-encoded
		// text double-encodes it and the row ends up holding a JSON *string* rather
		// than an object — which reads back as every field undefined. The cast is
		// only to satisfy sql.json()'s index-signature requirement, which a plain
		// interface does not have.
		const listingJson = property.listing as unknown as Parameters<typeof sql.json>[0];
		await sql`
			INSERT INTO properties (property_id, name, listing)
			VALUES (${property.propertyId}, ${property.name}, ${sql.json(listingJson)})
			ON CONFLICT (property_id) DO UPDATE SET
				name    = EXCLUDED.name,
				listing = EXCLUDED.listing
		`;

		// Only sections whose text actually changed are re-embedded — re-running
		// this on an unchanged guidebook costs one SELECT and no OpenAI calls.
		const counts = await reindexProperty(sql, embeddings, property.propertyId, property.sections);
		console.log(`  ${formatCounts(counts)}`);

		// Bookings for this property. Dates resolve from offsets at seed time, so a
		// database seeded weeks ago still has a stay in progress to demo against.
		const fixtures = BOOKING_FIXTURES.filter((b) => b.propertyId === property.propertyId);
		if (fixtures.length > 0) {
			const today = new Date();
			await sql.begin(async (tx) => {
				await tx`DELETE FROM bookings WHERE property_id = ${property.propertyId}`;
				for (const b of fixtures) {
					const checkIn = offsetDate(today, b.checkInOffsetDays);
					const checkOut = offsetDate(today, b.checkOutOffsetDays);
					await tx`
						INSERT INTO bookings (
							property_id, booking_ref, guest_name, check_in, check_out,
							unit, guest_count, status, late_checkout_approved, notes
						) VALUES (
							${property.propertyId}, ${b.bookingRef}, ${b.guestName},
							${checkIn}::date, ${checkOut}::date,
							${b.unit}, ${b.guestCount}, ${b.status},
							${b.lateCheckoutApproved}, ${b.notes}
						)
					`;
					console.log(`  ${b.bookingRef}  ${b.guestName}  ${checkIn} -> ${checkOut}  (${b.status})`);
				}
			});
		}
	}

	console.log('\nDone.');
	const first = properties[0];
	const firstBooking = BOOKING_FIXTURES.find((b) => b.propertyId === first.propertyId);
	console.log(`  chat:  /p/${first.propertyId}${firstBooking ? `?booking=${firstBooking.bookingRef}` : ''}`);

	await sql.end();
}

main().catch((err) => {
	console.error('\nSeed failed:', err);
	process.exit(1);
});
