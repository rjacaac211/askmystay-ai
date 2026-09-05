import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { listProperties } from '$lib/server/properties';

/**
 * The landing page lists whatever properties are actually seeded, rather than
 * hardcoding one. The server has always been property-agnostic; this is what
 * makes that visible.
 */
export const load: PageServerLoad = async () => {
	return { properties: await listProperties(getDb()) };
};
