import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { findProperty } from '$lib/server/properties';

export const load: PageServerLoad = async ({ params, url }) => {
	const property = await findProperty(getDb(), params.propertyId);

	// 404 rather than rendering a chat box wired to an empty corpus, where every
	// question would come back as the off-topic refusal and look like a bug.
	if (!property) error(404, 'No such property.');

	return {
		property,
		bookingRef: url.searchParams.get('booking')?.trim() ?? ''
	};
};
