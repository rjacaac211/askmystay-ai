/**
 * Fixture bookings for the demo properties.
 *
 * Pure data + date arithmetic — no I/O, no env, no clients. `scripts/seed.ts`
 * imports this directly under tsx, outside Vite, so it must not touch `$env/*`
 * or `$lib/*`.
 *
 * Dates are stored as offsets from the seed date rather than absolute values so
 * a demo seeded months ago still shows a stay in progress. A fixture that has
 * to be hand-edited to stay believable stops being demoed.
 */

export interface BookingFixture {
	propertyId: string;
	bookingRef: string;
	guestName: string;
	/** Days from the seed date. Negative is in the past. */
	checkInOffsetDays: number;
	checkOutOffsetDays: number;
	unit: string | null;
	guestCount: number;
	status: 'confirmed' | 'in_progress' | 'completed' | 'cancelled';
	lateCheckoutApproved: boolean;
	notes: string | null;
}

export const BOOKING_FIXTURES: BookingFixture[] = [
	{
		propertyId: 'sunset-ridge-cabin',
		bookingRef: 'BK-4471',
		guestName: 'Alina Moreau',
		checkInOffsetDays: -2,
		checkOutOffsetDays: 3,
		unit: 'Main A-Frame',
		guestCount: 2,
		status: 'in_progress',
		lateCheckoutApproved: false,
		notes: 'Arriving with one small dog (approved).'
	},
	{
		propertyId: 'sunset-ridge-cabin',
		bookingRef: 'BK-5518',
		guestName: 'Marcus Feld',
		checkInOffsetDays: 14,
		checkOutOffsetDays: 18,
		unit: 'Main A-Frame',
		guestCount: 4,
		status: 'confirmed',
		lateCheckoutApproved: true,
		notes: null
	},
	{
		propertyId: 'sunset-ridge-cabin',
		bookingRef: 'BK-3092',
		guestName: 'Priya Raman',
		checkInOffsetDays: -30,
		checkOutOffsetDays: -25,
		unit: 'Main A-Frame',
		guestCount: 2,
		status: 'completed',
		lateCheckoutApproved: false,
		notes: null
	},
	// A second property's stay. Its unit name and guest are deliberately unlike
	// anything at Sunset Ridge, so a cross-property leak is obvious in an
	// assertion rather than plausible-looking. The eval suite uses this ref
	// against the WRONG property to prove findBooking's property_id predicate
	// actually does something.
	{
		propertyId: 'harbor-loft-astoria',
		bookingRef: 'HL-8802',
		guestName: 'Tomas Brink',
		checkInOffsetDays: -1,
		checkOutOffsetDays: 4,
		unit: 'Loft 4B',
		guestCount: 2,
		status: 'in_progress',
		lateCheckoutApproved: false,
		notes: null
	}
];

/** ISO `YYYY-MM-DD`, `offsetDays` from `from`. UTC to keep seeds reproducible. */
export function offsetDate(from: Date, offsetDays: number): string {
	const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
	d.setUTCDate(d.getUTCDate() + offsetDays);
	return d.toISOString().slice(0, 10);
}
