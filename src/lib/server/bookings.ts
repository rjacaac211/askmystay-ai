import type { Sql } from '$lib/clients';

export interface Booking {
	bookingRef: string;
	guestName: string;
	/** ISO `YYYY-MM-DD`. */
	checkIn: string;
	checkOut: string;
	unit: string | null;
	guestCount: number;
	status: string;
	lateCheckoutApproved: boolean;
	notes: string | null;
}

/**
 * Look up one booking, scoped to the property.
 *
 * `booking_ref` is unique on its own, so the `property_id` predicate is not
 * needed to find the row — it is here as a scoping guardrail. Without it a ref
 * belonging to one property would resolve on another property's assistant and
 * leak a guest's name, dates and unit across listings. The eval suite covers
 * this case explicitly.
 *
 * Returns null rather than throwing: an unknown or mismatched ref is a normal
 * guest-facing condition (a stale link), not an error.
 */
export async function findBooking(
	sql: Sql,
	propertyId: string,
	bookingRef: string
): Promise<Booking | null> {
	const rows = await sql<
		{
			booking_ref: string;
			guest_name: string;
			check_in: string;
			check_out: string;
			unit: string | null;
			guest_count: number;
			status: string;
			late_checkout_approved: boolean;
			notes: string | null;
		}[]
	>`
		SELECT booking_ref,
		       guest_name,
		       to_char(check_in,  'YYYY-MM-DD') AS check_in,
		       to_char(check_out, 'YYYY-MM-DD') AS check_out,
		       unit,
		       guest_count,
		       status,
		       late_checkout_approved,
		       notes
		FROM bookings
		WHERE property_id = ${propertyId} AND booking_ref = ${bookingRef}
		LIMIT 1
	`;

	if (rows.length === 0) return null;
	const r = rows[0];

	return {
		bookingRef: r.booking_ref,
		guestName: r.guest_name,
		checkIn: r.check_in,
		checkOut: r.check_out,
		unit: r.unit,
		guestCount: Number(r.guest_count),
		status: r.status,
		lateCheckoutApproved: r.late_checkout_approved,
		notes: r.notes
	};
}

/**
 * Confirm a reference belongs to the person holding it.
 *
 * A booking reference on its own is a bearer token — "HL-8802" is short,
 * sequential-looking and guessable, and anyone who types it would otherwise see
 * that guest's dates, unit and host notes. Requiring the surname alongside it is
 * the hotel/airline pattern: two factors, one screen, nothing extra to carry.
 *
 * Matching is case-insensitive and trims whitespace, and compares only the LAST
 * whitespace-separated word of the stored name, so "moreau", " Moreau " and
 * "Alina Moreau" all work. Being strict here punishes the legitimate guest far
 * more than the attacker, who is guessing references anyway.
 *
 * Returns null for both "no such reference" and "wrong surname", deliberately:
 * distinguishing them would confirm which references exist.
 */
export async function verifyBooking(
	sql: Sql,
	propertyId: string,
	bookingRef: string,
	surname: string
): Promise<Booking | null> {
	const booking = await findBooking(sql, propertyId, bookingRef.trim());
	if (!booking) return null;

	const given = surname.trim().toLowerCase();
	if (given === '') return null;

	const parts = booking.guestName.trim().toLowerCase().split(/\s+/);
	const actualSurname = parts[parts.length - 1] ?? '';

	// Accept the surname alone or the full name as typed.
	const matches = given === actualSurname || given === booking.guestName.trim().toLowerCase();
	return matches ? booking : null;
}

/**
 * Render a booking for the prompt.
 *
 * Deliberately a flat labelled block rather than JSON: it costs fewer tokens,
 * and the model reproduces dates more reliably from `Check-out: 2026-09-08`
 * than from a nested object. `todayIso` is passed in so the model can reason
 * about "tonight" or "tomorrow" without being asked to know the date.
 */
export function renderBooking(booking: Booking, todayIso: string): string {
	const lines = [
		`Today's date: ${todayIso}`,
		`Booking reference: ${booking.bookingRef}`,
		`Guest name: ${booking.guestName}`,
		`Status: ${booking.status}`,
		`Check-in date: ${booking.checkIn}`,
		`Check-out date: ${booking.checkOut}`,
		`Guests: ${booking.guestCount}`
	];
	if (booking.unit) lines.push(`Unit: ${booking.unit}`);
	lines.push(`Late check-out approved: ${booking.lateCheckoutApproved ? 'yes' : 'no'}`);
	if (booking.notes) lines.push(`Host notes: ${booking.notes}`);
	return lines.join('\n');
}
