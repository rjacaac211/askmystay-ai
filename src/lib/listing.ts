import type { ContentSection } from './content.js';

/**
 * Listing details — what a guest browsing the catalogue sees.
 *
 * Deliberately separate from the guidebook. They have different consumers: this
 * is rendered by the property page, the guidebook is read by the assistant. And
 * they are written at different times by different people — a listing changes
 * when the host re-prices or re-photographs, a guidebook when the door code
 * changes.
 *
 * Pure of Vite: `scripts/seed.ts` imports it under tsx.
 */
export interface PropertyListing {
	name: string;
	tagline: string;
	location: string;
	nightlyRate: number;
	currency: string;
	guests: number;
	bedrooms: number;
	beds: number;
	baths: number;
	description: string;
	highlights: string[];
	amenities: string[];
	houseRules: string[];
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Parse a listing file, falling back rather than throwing.
 *
 * A malformed listing should degrade the page, never take down retrieval for a
 * property whose guidebook is perfectly fine.
 */
export function parseListing(raw: unknown, fallbackName: string): PropertyListing {
	const l = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
	const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
	const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);

	return {
		name: str(l.name, fallbackName),
		tagline: str(l.tagline),
		location: str(l.location),
		nightlyRate: num(l.nightlyRate, 0),
		currency: str(l.currency, 'USD'),
		guests: num(l.guests, 0),
		bedrooms: num(l.bedrooms, 0),
		beds: num(l.beds, 0),
		baths: num(l.baths, 0),
		description: str(l.description),
		highlights: stringList(l.highlights),
		amenities: stringList(l.amenities),
		houseRules: stringList(l.houseRules)
	};
}

/**
 * The listing, rendered as one more retrievable section.
 *
 * Without this the page and the assistant disagree: the page states "sleeps 4,
 * 2 bedrooms" while the assistant refuses "how many bedrooms?" because no
 * guidebook section says so. Anything shown to a guest should be answerable to
 * that guest.
 *
 * Its `sourceId` is namespaced so incremental sync treats it like any other
 * section — edit the listing, re-seed, and only this chunk is re-embedded.
 */
export function listingToSection(listing: PropertyListing): ContentSection {
	const heading = 'About This Place';
	const lines = [
		`## ${heading}`,
		'',
		`${listing.name} is in ${listing.location}. ${listing.description}`,
		'',
		`It sleeps ${listing.guests} across ${listing.bedrooms} bedroom${listing.bedrooms === 1 ? '' : 's'}, ` +
			`with ${listing.beds} bed${listing.beds === 1 ? '' : 's'} and ${listing.baths} bathroom${listing.baths === 1 ? '' : 's'}. ` +
			`The nightly rate is ${listing.nightlyRate} ${listing.currency}.`
	];

	if (listing.highlights.length > 0) {
		lines.push('', `Highlights: ${listing.highlights.join('; ')}.`);
	}
	if (listing.amenities.length > 0) {
		lines.push('', `Amenities: ${listing.amenities.join('; ')}.`);
	}

	return {
		sourceId: 'listing:about',
		heading,
		content: lines.join('\n')
	};
}
