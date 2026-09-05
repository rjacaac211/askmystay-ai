import type { Sql } from '$lib/clients';
import type { Booking } from './bookings';

/**
 * Actions the assistant can take, as opposed to facts it can look up.
 *
 * This is the other half of the argument in `loadBooking`. Reading a booking is
 * prefetched because it is six fields behind a unique key and a tool call would
 * only add a round-trip. Requesting a late check-out is different in kind: it
 * WRITES, the guest has to have asked for it, and the arguments (which time?)
 * have to be pulled out of natural language. That is what tools are for.
 */

export type LateCheckoutOutcome = 'recorded' | 'already_approved' | 'already_requested';

export interface LateCheckoutResult {
	outcome: LateCheckoutOutcome;
	requestedTime: string | null;
}

/**
 * Record a late check-out request for a stay.
 *
 * Idempotent per booking: a guest who asks twice in one conversation (or on the
 * phone and then in chat) does not generate two rows for a host to reconcile.
 * The distinct outcomes exist so the model can say something true in each case
 * rather than confirming a request it did not actually file.
 */
export async function requestLateCheckout(
	sql: Sql,
	propertyId: string,
	booking: Booking,
	requestedTime: string | null
): Promise<LateCheckoutResult> {
	if (booking.lateCheckoutApproved) {
		// Deliberately drops the requested time. Approval on this booking is
		// blanket, not for the hour the guest just named, and echoing it back made
		// the model say "you're already approved for 2pm" — confirming something
		// no one agreed to.
		return { outcome: 'already_approved', requestedTime: null };
	}

	const existing = await sql<{ requested_time: string | null }[]>`
		SELECT requested_time
		FROM late_checkout_requests
		WHERE property_id = ${propertyId}
		  AND booking_ref = ${booking.bookingRef}
		  AND status = 'pending'
		LIMIT 1
	`;

	if (existing.length > 0) {
		return { outcome: 'already_requested', requestedTime: existing[0].requested_time };
	}

	await sql`
		INSERT INTO late_checkout_requests (property_id, booking_ref, requested_time)
		VALUES (${propertyId}, ${booking.bookingRef}, ${requestedTime})
	`;

	return { outcome: 'recorded', requestedTime };
}
