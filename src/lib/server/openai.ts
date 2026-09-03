import type { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { env } from '$env/dynamic/private';
import { createChatModel, createEmbeddings } from '$lib/clients';

function requireApiKey(): string {
	const key = env.OPENAI_API_KEY;
	if (!key) {
		throw new Error('OPENAI_API_KEY is not set. Copy .env.example to .env and fill it in.');
	}
	return key;
}

let _embeddings: OpenAIEmbeddings | null = null;
let _chat: ChatOpenAI | null = null;

/**
 * Both clients are constructed lazily, on first use.
 *
 * Constructing them at module load would break `vite build`, which imports
 * every server module to analyse routes — in a build environment (and in the
 * Docker build stage) OPENAI_API_KEY is deliberately absent. This is also why
 * the key comes from `$env/dynamic/private` rather than `$env/static/private`:
 * the static form is inlined at build time and would bake in the missing value.
 */
export function getEmbeddings(): OpenAIEmbeddings {
	if (!_embeddings) _embeddings = createEmbeddings(requireApiKey());
	return _embeddings;
}

export function getChatModel(): ChatOpenAI {
	if (!_chat) _chat = createChatModel(requireApiKey());
	return _chat;
}
