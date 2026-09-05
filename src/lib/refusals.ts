/**
 * The exact sentences that count as a refusal.
 *
 * Split out of `agent.ts` so the browser can import them without dragging in the
 * database and model clients that module needs. The widget compares an answer
 * against NO_BOOKING_ANSWER to decide whether to offer the booking form, which
 * only works if both sides read the same constant — the alternative is a copy of
 * the string in the UI that silently drifts the next time the wording changes.
 *
 * Pure constants: no I/O, no env, safe on both sides of the wire.
 */

export const FALLBACK_ANSWER = "I don't have that info, please contact your host.";

/**
 * Second refusal: the answer needs a booking that is not attached — either a
 * fact only the reservation holds, or a section withheld pending one. Distinct
 * from FALLBACK_ANSWER because the fix is different: the guest needs their
 * booking, not a different question, and the widget turns this into an inline
 * offer to attach it.
 *
 * Written WITHOUT quotation marks around the button label on purpose. A version
 * that quoted it with typographic quotes was reproduced by the model with
 * straight ones, which broke the exact-match contract and silently reclassified
 * every refusal as a grounded answer. Keep this sentence to characters a model
 * has no reason to normalise.
 *
 * The wording points at that button, so it is tied to the chat surface. Any
 * future surface without one would need its own phrasing.
 */
export const NO_BOOKING_ANSWER =
	"I don't have your booking details for this stay. Use the Attach my booking button just below and enter your booking reference and the surname it was made under, and I can answer about your dates, your unit, and anything else specific to your stay.";

/**
 * Every string that counts as a refusal.
 *
 * `grounded` is a membership test against this list, and BOTH refusal paths
 * (the fallback node and the model's verbatim reply) must draw from it. Adding
 * a refusal sentence anywhere without adding it here silently reports a refusal
 * as a grounded answer.
 */
export const REFUSAL_ANSWERS: readonly string[] = [FALLBACK_ANSWER, NO_BOOKING_ANSWER];

/**
 * Fold away differences a model introduces without changing meaning.
 *
 * Asking for a sentence "verbatim" gets you the words, not the typography:
 * curly quotes come back straight, and whitespace around line breaks varies.
 * Comparing raw strings makes the refusal contract brittle in a way that fails
 * silently — a refusal that no longer matches is scored as a real answer, which
 * is the worst possible direction for it to break.
 */
export function normalizeForMatch(text: string): string {
	return text
		.replace(/[‘’]/g, "'")
		.replace(/[“”]/g, '"')
		.replace(/[–—]/g, '-')
		.replace(/\s+/g, ' ')
		.trim();
}

export function isRefusal(answer: string): boolean {
	const normalized = normalizeForMatch(answer);
	return REFUSAL_ANSWERS.some((r) => normalizeForMatch(r) === normalized);
}

/**
 * True when a reply carries the "no booking attached" refusal.
 *
 * `includes` rather than equality: a compound question ("what time is check-out,
 * and when do I check out?") legitimately answers one half and refuses the
 * other, and the widget should still offer the booking form in that case.
 */
export function mentionsNoBooking(answer: string): boolean {
	return normalizeForMatch(answer).includes(normalizeForMatch(NO_BOOKING_ANSWER));
}
