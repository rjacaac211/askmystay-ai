/**
 * Pure client factories — no `$env/*`, no Vite-only imports.
 *
 * The SvelteKit app wraps these in lazy, env-reading getters under
 * `src/lib/server/`; `scripts/seed.ts` (which runs under tsx, outside Vite,
 * where the `$env/*` aliases do not resolve) calls them directly with values
 * from process.env. Keeping the constructors here is what lets both worlds
 * share one configuration.
 */
import postgres from 'postgres';
import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

export type Sql = postgres.Sql;

/**
 * Embeddings are OpenAI-only, on purpose.
 *
 * Anthropic publishes no embeddings endpoint, so "use Claude" applies to
 * generation only — retrieval keeps its own provider. Do NOT swap this model
 * to chase provider symmetry: SIMILARITY_THRESHOLD in `agent.ts` was measured
 * against these exact vectors, and a different embedding model invalidates
 * that calibration along with every number quoted in the README.
 */
export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;

export type LlmProvider = 'anthropic' | 'openai';

/**
 * Two model roles, because they are not the same job.
 *
 * `answer` writes the guest-facing reply; `utility` does the mechanical
 * rewrite in `contextualize`, which is a one-line transformation that should
 * never pay for a larger model. They default to the same cheap model — the
 * split exists so raising answer quality does not silently raise the cost of
 * every follow-up turn as well.
 */
export type ModelRole = 'answer' | 'utility';

export const DEFAULT_CHAT_MODELS: Record<LlmProvider, Record<ModelRole, string>> = {
	// Haiku over Sonnet deliberately: guest questions are short lookups over
	// three excerpts, and a guest waiting on a chat bubble notices latency long
	// before they notice a larger model's prose.
	anthropic: {
		answer: 'claude-haiku-4-5-20251001',
		utility: 'claude-haiku-4-5-20251001'
	},
	openai: {
		answer: 'gpt-4o-mini',
		utility: 'gpt-4o-mini'
	}
};

export function createDb(url: string): Sql {
	return postgres(url, { max: 5 });
}

export function createEmbeddings(apiKey: string): OpenAIEmbeddings {
	return new OpenAIEmbeddings({ model: EMBEDDING_MODEL, apiKey });
}

export interface ChatModelOptions {
	provider: LlmProvider;
	apiKey: string;
	/** Overrides the provider default for `role`. */
	model?: string;
	role?: ModelRole;
	temperature?: number;
}

/**
 * Returns the provider's chat model as a `BaseChatModel`.
 *
 * The return type is the interface rather than `ChatAnthropic | ChatOpenAI` so
 * callers cannot reach for provider-specific behaviour and quietly re-couple
 * the agent to one vendor.
 */
export function createChatModel({
	provider,
	apiKey,
	model,
	role = 'answer',
	temperature = 0.2
}: ChatModelOptions): BaseChatModel {
	const resolved = model ?? DEFAULT_CHAT_MODELS[provider][role];

	return provider === 'anthropic'
		? new ChatAnthropic({ model: resolved, temperature, apiKey })
		: new ChatOpenAI({ model: resolved, temperature, apiKey });
}
