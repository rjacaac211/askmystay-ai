import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { askQuestion } from '$lib/agent';

const MAX_QUESTION_LENGTH = 1000;

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

	const { propertyId, question, threadId } = body as Record<string, unknown>;

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

	// A thread is one guest conversation. The client persists it so follow-ups
	// land on the same history; a missing one starts a fresh conversation.
	const thread = threadId && threadId.trim() !== '' ? threadId : crypto.randomUUID();

	try {
		const result = await askQuestion({
			propertyId: propertyId.trim(),
			threadId: thread,
			question: question.trim()
		});
		return json({ answer: result.answer, threadId: result.threadId });
	} catch (err) {
		// Log the real cause server-side; never return it — misconfiguration
		// messages can name env vars and connection strings.
		console.error('[api/chat] failed to answer question:', err);
		error(500, 'Sorry, something went wrong answering that. Please try again.');
	}
};
