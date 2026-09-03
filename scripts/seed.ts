/**
 * One-time (idempotent) seed: chunk the guidebook, embed each chunk, and load
 * it into Postgres. Also creates the pgvector extension, the chunk table, and
 * the LangGraph checkpoint tables, so a fresh database needs only this script.
 *
 * Runs under tsx, OUTSIDE Vite — so the `$env/*` aliases do not resolve here.
 * It reads process.env (via dotenv) and calls the same factory functions the
 * app uses, sharing the chunker verbatim.
 */
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

import { chunkGuidebook } from '../src/lib/chunk.js';

import { createDb, createEmbeddings, EMBEDDING_DIMENSIONS } from '../src/lib/clients.js';

const PROPERTY_ID = process.env.SEED_PROPERTY_ID ?? 'sunset-ridge-cabin';

const here = dirname(fileURLToPath(import.meta.url));
const GUIDEBOOK_PATH = resolve(here, '../src/data/guidebook.md');

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		console.error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
		process.exit(1);
	}
	return value;
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
	await sql`
		CREATE INDEX IF NOT EXISTS guidebook_chunks_property_id_idx
		ON guidebook_chunks (property_id)
	`;
	// Deliberately no ivfflat/HNSW index on `embedding`: one guidebook is ~10
	// rows, where an exact scan is faster and an ivfflat index built on so few
	// rows measurably degrades recall. Add one when a property set grows large.

	console.log('Ensuring LangGraph checkpoint tables...');
	const checkpointer = PostgresSaver.fromConnString(databaseUrl);
	await checkpointer.setup();
	await checkpointer.end();

	console.log(`Reading ${GUIDEBOOK_PATH}`);
	const markdown = await readFile(GUIDEBOOK_PATH, 'utf-8');
	const chunks = chunkGuidebook(markdown);

	if (chunks.length === 0) {
		console.error('No "## " sections found in the guidebook — nothing to seed.');
		process.exit(1);
	}
	console.log(`Found ${chunks.length} sections:`);
	for (const c of chunks) console.log(`  - ${c.heading}`);

	console.log(`Embedding ${chunks.length} chunks...`);
	const vectors = await embeddings.embedDocuments(chunks.map((c) => c.content));

	// Idempotent: replace this property's rows rather than appending duplicates
	// on every re-run.
	console.log(`Replacing existing rows for property "${PROPERTY_ID}"...`);
	await sql.begin(async (tx) => {
		await tx`DELETE FROM guidebook_chunks WHERE property_id = ${PROPERTY_ID}`;
		for (let i = 0; i < chunks.length; i++) {
			await tx`
				INSERT INTO guidebook_chunks (property_id, content, embedding)
				VALUES (
					${PROPERTY_ID},
					${chunks[i].content},
					${`[${vectors[i].join(',')}]`}::vector
				)
			`;
		}
	});

	const [{ count }] = await sql<{ count: string }[]>`
		SELECT count(*)::text AS count FROM guidebook_chunks WHERE property_id = ${PROPERTY_ID}
	`;
	console.log(`\nDone. ${count} chunks stored for "${PROPERTY_ID}".`);

	await sql.end();
}

main().catch((err) => {
	console.error('\nSeed failed:', err);
	process.exit(1);
});
