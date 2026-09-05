import type { OpenAIEmbeddings } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { env } from '$env/dynamic/private';
import { createChatModel, createEmbeddings, type LlmProvider } from '$lib/clients';

/**
 * Generation is provider-agnostic; retrieval is not.
 *
 * `LLM_PROVIDER` switches who writes the answers (default Claude). Embeddings
 * always come from OpenAI because Anthropic has no embeddings endpoint — so
 * OPENAI_API_KEY stays required even on the Anthropic path, and running fully
 * on OpenAI needs only that one key.
 */
function resolveProvider(): LlmProvider {
	const raw = (env.LLM_PROVIDER ?? 'anthropic').trim().toLowerCase();
	if (raw !== 'anthropic' && raw !== 'openai') {
		throw new Error(`LLM_PROVIDER must be "anthropic" or "openai", got "${raw}".`);
	}
	return raw;
}

function requireKey(name: 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY'): string {
	const key = env[name];
	if (!key) {
		throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
	}
	return key;
}

let _embeddings: OpenAIEmbeddings | null = null;
let _answer: BaseChatModel | null = null;
let _utility: BaseChatModel | null = null;

/**
 * Every client is constructed lazily, on first use.
 *
 * Constructing them at module load would break `vite build`, which imports
 * every server module to analyse routes — in a build environment (and in the
 * Docker build stage) the API keys are deliberately absent. This is also why
 * they come from `$env/dynamic/private` rather than `$env/static/private`:
 * the static form is inlined at build time and would bake in the missing value.
 */
export function getEmbeddings(): OpenAIEmbeddings {
	if (!_embeddings) _embeddings = createEmbeddings(requireKey('OPENAI_API_KEY'));
	return _embeddings;
}

function chatModel(role: 'answer' | 'utility'): BaseChatModel {
	const provider = resolveProvider();
	const apiKey = requireKey(provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY');
	const override = role === 'answer' ? env.ANSWER_MODEL : env.UTILITY_MODEL;
	return createChatModel({ provider, apiKey, role, model: override || undefined });
}

/** Writes the guest-facing answer. */
export function getChatModel(): BaseChatModel {
	if (!_answer) _answer = chatModel('answer');
	return _answer;
}

/** Cheap model for mechanical rewrites — see `contextualize` in the agent. */
export function getUtilityModel(): BaseChatModel {
	if (!_utility) _utility = chatModel('utility');
	return _utility;
}
