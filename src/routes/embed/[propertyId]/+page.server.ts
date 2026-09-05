import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { findProperty } from '$lib/server/properties';
import { env } from '$env/dynamic/private';

function EMBED_ORIGINS(): string {
	const raw = env.EMBED_ORIGINS?.trim();
	// Defaults to 'self' rather than 'none': same-origin framing is what the
	// bundled demo page uses, and a feature that is broken until configured gets
	// configured wrongly in a hurry. Partner sites are a deliberate addition.
	if (!raw) return "'self'";
	// Space-separated origins, exactly as CSP wants them. '*' is accepted but is
	// a choice the operator has to type out, never a default.
	return raw.split(/[\s,]+/).filter(Boolean).join(' ');
}

/**
 * The widget's iframe target. Same data as /p/[propertyId], rendered without
 * page chrome so it sits inside a small box on someone else's site.
 */
export const load: PageServerLoad = async ({ params, url, setHeaders }) => {
	const property = await findProperty(getDb(), params.propertyId);
	if (!property) error(404, 'No such property.');

	// This route — and only this route — is allowed to be framed. SvelteKit does
	// not set frame-ancestors itself, and the default of "anyone may frame this"
	// is how a phishing page ends up wrapping a real assistant. `EMBED_ORIGINS`
	// is an explicit allowlist; 'none' when unset, so embedding is opt-in.
	setHeaders({
		'content-security-policy': `frame-ancestors ${EMBED_ORIGINS()};`,
		// Guest transcripts are per-stay. Nothing here should sit in a CDN.
		'cache-control': 'no-store'
	});

	return {
		property,
		bookingRef: url.searchParams.get('booking')?.trim() ?? ''
	};
};
