import { env } from '$env/dynamic/private';
import { createDb, type Sql } from '$lib/clients';

export type { Sql };

let _sql: Sql | null = null;

/**
 * Lazy singleton. Constructed on first request, never at module load time, so
 * importing this during `vite build` route analysis does not require
 * DATABASE_URL to be set in the build environment.
 */
export function getDb(): Sql {
	if (!_sql) {
		const url = env.DATABASE_URL;
		if (!url) {
			throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
		}
		_sql = createDb(url);
	}
	return _sql;
}
