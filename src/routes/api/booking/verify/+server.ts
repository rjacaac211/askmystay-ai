import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { getDb } from '$lib/server/db';
import { verifyBooking } from '$lib/server/bookings';

/**
 * Attach a stay to a conversation.
 *
 * The widget calls this before it starts asking about a booking, so a wrong
 * reference produces a clear "we couldn't find that" in the form rather than a
 * refusal in the chat that reads like the assistant being unhelpful.
 *
 * It is also, unavoidably, an oracle: anything that says whether a reference
 * exists can be used to hunt for references. Three defences, in order of how
 * much they matter:
 *
 * 1. The surname is required, so a correct reference alone reveals nothing.
 * 2. The response is identical for "no such reference" and "wrong surname".
 * 3. Attempts are rate limited per IP.
 *
 * The limiter is in-process and therefore per-instance — fine for one container,
 * and the wrong tool the moment this runs behind a load balancer. Reach for a
 * shared store (the same Postgres, or Redis) at that point rather than trusting
 * this to hold.
 */

const MAX_REF_LENGTH = 64;
const MAX_SURNAME_LENGTH = 120;

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS_PER_WINDOW = 10;

const attempts = new Map<string, { count: number; resetAt: number }>();

function rateLimited(key: string): boolean {
	const now = Date.now();
	const entry = attempts.get(key);

	if (!entry || now > entry.resetAt) {
		attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
		// Opportunistic sweep so a long-running process does not accumulate an
		// entry per IP for ever. Cheap: this only runs on a window rollover.
		if (attempts.size > 10_000) {
			for (const [k, v] of attempts) if (now > v.resetAt) attempts.delete(k);
		}
		return false;
	}

	entry.count += 1;
	return entry.count > MAX_ATTEMPTS_PER_WINDOW;
}

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		error(400, 'Request body must be valid JSON.');
	}

	if (typeof body !== 'object' || body === null) {
		error(400, 'Request body must be a JSON object.');
	}

	const { propertyId, bookingRef, surname } = body as Record<string, unknown>;

	if (typeof propertyId !== 'string' || propertyId.trim() === '') {
		error(400, 'propertyId is required.');
	}
	if (typeof bookingRef !== 'string' || bookingRef.trim() === '') {
		error(400, 'bookingRef is required.');
	}
	if (typeof surname !== 'string' || surname.trim() === '') {
		error(400, 'surname is required.');
	}
	if (bookingRef.length > MAX_REF_LENGTH || surname.length > MAX_SURNAME_LENGTH) {
		error(400, 'bookingRef or surname is too long.');
	}

	if (rateLimited(getClientAddress())) {
		error(429, 'Too many attempts. Please wait a minute and try again.');
	}

	try {
		const booking = await verifyBooking(
			getDb(),
			propertyId.trim(),
			bookingRef.trim(),
			surname.trim()
		);

		if (!booking) {
			// 200, not 404: the status code should not be a signal either.
			return json({ ok: false });
		}

		// Only what the widget needs to confirm the right stay was attached. The
		// assistant reads the full booking server-side; there is no reason to ship
		// host notes or the guest count to the browser.
		return json({
			ok: true,
			bookingRef: booking.bookingRef,
			guestName: booking.guestName,
			checkIn: booking.checkIn,
			checkOut: booking.checkOut
		});
	} catch (err) {
		console.error('[api/booking/verify] failed:', err);
		error(500, 'Sorry, we could not check that booking. Please try again.');
	}
};
