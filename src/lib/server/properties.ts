import type { Sql } from '$lib/clients';
import { parseListing, type PropertyListing } from '$lib/listing';

export interface Property {
	propertyId: string;
	name: string;
	listing: PropertyListing;
}

/**
 * The properties this deployment serves.
 *
 * Retrieval and bookings were already scoped by `property_id`; this table gives
 * that id a display name and the catalogue copy, so the UI hardcodes neither.
 * It is written by the seed, so it always reflects content that actually exists.
 */
export async function listProperties(sql: Sql): Promise<Property[]> {
	const rows = await sql<{ property_id: string; name: string; listing: unknown }[]>`
		SELECT property_id, name, listing FROM properties ORDER BY name
	`;
	return rows.map((r) => ({
		propertyId: r.property_id,
		name: r.name,
		listing: parseListing(r.listing, r.name)
	}));
}

/**
 * One property, or null if this deployment does not serve it.
 *
 * Returning null rather than throwing is what lets a route 404 cleanly on an
 * unknown id instead of leaking a database error, and it is the check that stops
 * `/p/anything` from rendering a page wired to an empty corpus.
 */
export async function findProperty(sql: Sql, propertyId: string): Promise<Property | null> {
	const rows = await sql<{ property_id: string; name: string; listing: unknown }[]>`
		SELECT property_id, name, listing FROM properties WHERE property_id = ${propertyId} LIMIT 1
	`;
	if (rows.length === 0) return null;
	return {
		propertyId: rows[0].property_id,
		name: rows[0].name,
		listing: parseListing(rows[0].listing, rows[0].name)
	};
}
