/**
 * Threshold calibration for SIMILARITY_THRESHOLD in src/lib/agent.ts.
 *
 * The threshold is a measured value, not a guess. Run this after editing the
 * guidebook (and re-seeding) to check it is still sane:
 *
 *   npm run calibrate
 *
 * It scores two populations against the seeded chunks — questions the guidebook
 * DOES answer, and questions it does NOT — and reports where a cutoff would sit.
 *
 * The headline result is that these populations OVERLAP. Cosine similarity
 * measures topical relatedness, not whether an answer is present, so no cutoff
 * separates them. That is why the threshold is set low, as an off-topic floor
 * only, and the model itself decides groundedness. See the comment on
 * SIMILARITY_THRESHOLD.
 */
import 'dotenv/config';
import { createDb, createEmbeddings } from '../src/lib/clients.js';

const PROPERTY_ID = process.env.SEED_PROPERTY_ID ?? 'sunset-ridge-cabin';

/** Questions this guidebook genuinely answers (including explicit "we don't have X" facts). */
const ANSWERABLE = [
	'What time is check-in?',
	'and check-out?',
	'Can I bring my cat?',
	'Can I bring my dog?',
	'what about my cat?',
	'What is the wifi password?',
	'Is the wifi password case sensitive?',
	'Where do I park?',
	'Do I need chains?',
	'How do I work the thermostat?',
	'Is there air conditioning?',
	'When is trash day?',
	'Can I recycle glass?',
	'Can I smoke on the deck?',
	'What are the quiet hours?',
	'How many people can stay?',
	'Is the water safe to drink?',
	'What kind of coffee filters?',
	'Can I charge my EV?',
	'How do I contact the host?',
	'Where is the nearest urgent care?',
	'Where should we eat dinner?',
	'Any good hikes nearby?',
	'Where is the grocery store?',
	'Is there a fire extinguisher?',
	'Can I light the wood stove?',
	'What do I do if the power goes out?'
];

/** Questions this guidebook says nothing about. */
const UNANSWERABLE = [
	'Is there a pool?',
	'Is there a hot tub?',
	'Is there a washer and dryer?',
	'Is there a BBQ grill?',
	'Do you have a crib for a baby?',
	'Is there an airport shuttle?',
	'Can I rent skis here?',
	'What is your refund policy?',
	'Is there a gym?',
	'Do you have a highchair?',
	'What is the wifi speed in Mbps?',
	'What is the capital of France?',
	'Can you write me a Python script?',
	'Tell me a joke',
	'Who won the world cup?'
];

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		console.error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
		process.exit(1);
	}
	return value;
}

async function main() {
	const sql = createDb(requireEnv('DATABASE_URL'));
	const embeddings = createEmbeddings(requireEnv('OPENAI_API_KEY'));

	const [{ count }] = await sql<{ count: string }[]>`
		SELECT count(*)::text AS count FROM guidebook_chunks WHERE property_id = ${PROPERTY_ID}
	`;
	if (Number(count) === 0) {
		console.error(`No chunks for "${PROPERTY_ID}". Run \`npm run seed\` first.`);
		process.exit(1);
	}

	const score = async (question: string) => {
		const v = await embeddings.embedQuery(question);
		const literal = `[${v.join(',')}]`;
		const rows = await sql<{ heading: string; similarity: number }[]>`
			SELECT split_part(content, E'\n', 1) AS heading,
			       1 - (embedding <=> ${literal}::vector) AS similarity
			FROM guidebook_chunks
			WHERE property_id = ${PROPERTY_ID}
			ORDER BY embedding <=> ${literal}::vector
			LIMIT 1
		`;
		return {
			question,
			sim: Number(rows[0].similarity),
			heading: rows[0].heading.replace('## ', '')
		};
	};

	const answerable = [];
	for (const q of ANSWERABLE) answerable.push(await score(q));
	const unanswerable = [];
	for (const q of UNANSWERABLE) unanswerable.push(await score(q));

	answerable.sort((a, b) => a.sim - b.sim);
	unanswerable.sort((a, b) => b.sim - a.sim);

	console.log('\nSHOULD ANSWER (lowest first — a threshold breaks these):');
	for (const r of answerable) {
		console.log(`  ${r.sim.toFixed(4)}  ${r.question.padEnd(38)} -> ${r.heading}`);
	}
	console.log('\nSHOULD REFUSE (highest first — a threshold must block these):');
	for (const r of unanswerable) {
		console.log(`  ${r.sim.toFixed(4)}  ${r.question.padEnd(38)} -> ${r.heading}`);
	}

	const minAnswerable = answerable[0];
	const maxUnanswerable = unanswerable[0];
	console.log(`\nlowest answerable    ${minAnswerable.sim.toFixed(4)}  "${minAnswerable.question}"`);
	console.log(`highest unanswerable ${maxUnanswerable.sim.toFixed(4)}  "${maxUnanswerable.question}"`);

	if (minAnswerable.sim > maxUnanswerable.sim) {
		console.log(
			`\nClean separation — any threshold between them classifies every question correctly.`
		);
	} else {
		console.log(
			`\nOVERLAP of ${(maxUnanswerable.sim - minAnswerable.sim).toFixed(4)}: no threshold ` +
				`separates these. Keep it low (off-topic floor only) and let the model judge\n` +
				`groundedness — that is the design in src/lib/agent.ts.`
		);
	}

	console.log('\nthreshold | answerable kept | unanswerable blocked');
	for (const t of [0.3, 0.28, 0.25, 0.22, 0.2, 0.18, 0.15, 0.12, 0.1]) {
		const kept = answerable.filter((r) => r.sim >= t).length;
		const blocked = unanswerable.filter((r) => r.sim < t).length;
		const note = kept === answerable.length ? '  <- keeps every answerable question' : '';
		console.log(
			`     ${t.toFixed(2)} |  ${String(kept).padStart(2)}/${answerable.length}` +
				`          |  ${String(blocked).padStart(2)}/${unanswerable.length}${note}`
		);
	}

	await sql.end();
}

main().catch((err) => {
	console.error('\nCalibration failed:', err);
	process.exit(1);
});
