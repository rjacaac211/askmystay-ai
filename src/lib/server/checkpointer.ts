import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { env } from '$env/dynamic/private';

let _checkpointer: PostgresSaver | null = null;
let _setup: Promise<void> | null = null;

/**
 * Lazy PostgresSaver, reusing the same Postgres instance that holds the vector
 * table. This is what gives the agent memory across requests and restarts:
 * LangGraph restores prior `messages` for a thread_id before the graph runs.
 *
 * `.setup()` creates the checkpoint tables and is idempotent. It is memoised on
 * a promise so concurrent first requests do not race to run the migration.
 */
export function getCheckpointer(): PostgresSaver {
	if (!_checkpointer) {
		const url = env.DATABASE_URL;
		if (!url) {
			throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
		}
		_checkpointer = PostgresSaver.fromConnString(url);
	}
	return _checkpointer;
}

export async function ensureCheckpointerReady(): Promise<PostgresSaver> {
	const checkpointer = getCheckpointer();
	if (!_setup) {
		_setup = checkpointer.setup().catch((err: unknown) => {
			// Let the next request retry rather than caching a failed migration.
			_setup = null;
			throw err;
		});
	}
	await _setup;
	return checkpointer;
}
