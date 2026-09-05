import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { askQuestionStream } from '$lib/agent';

/**
 * Streaming counterpart to POST /api/chat.
 *
 * Kept as its own route rather than a flag on /api/chat: one returns JSON and
 * one returns an event stream, and a route that switches its entire response
 * shape on a request field is harder to reason about than two routes. /api/chat
 * stays the simple request/response API the README documents.
 *
 * Frames are `{type:"delta"}` then one `{type:"done"}` carrying threadId and
 * grounded, or `{type:"error"}` if the turn failed after headers were already
 * sent — at that point the status code is long gone, so the error has to travel
 * in-band.
 */

const MAX_QUESTION_LENGTH = 1000;
const MAX_BOOKING_REF_LENGTH = 64;

export const POST: RequestHandler = async ({ request }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		error(400, 'Request body must be valid JSON.');
	}

	if (typeof body !== 'object' || body === null) {
		error(400, 'Request body must be a JSON object.');
	}

	const { propertyId, question, threadId, bookingRef } = body as Record<string, unknown>;

	if (typeof propertyId !== 'string' || propertyId.trim() === '') {
		error(400, 'propertyId is required.');
	}
	if (typeof question !== 'string' || question.trim() === '') {
		error(400, 'question is required.');
	}
	if (question.length > MAX_QUESTION_LENGTH) {
		error(400, `question must be ${MAX_QUESTION_LENGTH} characters or fewer.`);
	}
	if (threadId !== undefined && typeof threadId !== 'string') {
		error(400, 'threadId must be a string when provided.');
	}
	if (bookingRef !== undefined && typeof bookingRef !== 'string') {
		error(400, 'bookingRef must be a string when provided.');
	}
	if (typeof bookingRef === 'string' && bookingRef.length > MAX_BOOKING_REF_LENGTH) {
		error(400, `bookingRef must be ${MAX_BOOKING_REF_LENGTH} characters or fewer.`);
	}

	const thread = threadId && threadId.trim() !== '' ? threadId : crypto.randomUUID();

	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			const send = (payload: unknown) =>
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));

			try {
				const turn = askQuestionStream({
					propertyId: propertyId.trim(),
					threadId: thread,
					question: question.trim(),
					bookingRef: typeof bookingRef === 'string' ? bookingRef.trim() : undefined
				});

				// The generator's RETURN value carries grounded/threadId, which a
				// plain for-await would discard — hence driving next() by hand.
				let step = await turn.next();
				while (!step.done) {
					send({ type: 'delta', text: step.value });
					step = await turn.next();
				}

				send({ type: 'done', threadId: step.value.threadId, grounded: step.value.grounded });
			} catch (err) {
				// Log the real cause server-side; never return it — misconfiguration
				// messages can name env vars and connection strings.
				console.error('[api/chat/stream] failed to answer question:', err);
				send({ type: 'error', message: 'Sorry, something went wrong answering that.' });
			} finally {
				controller.close();
			}
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive',
			// Without this an nginx or similar in front of adapter-node buffers the
			// whole response and the stream arrives as one lump.
			'x-accel-buffering': 'no'
		}
	});
};
