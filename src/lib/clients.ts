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

export type Sql = postgres.Sql;

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;
export const CHAT_MODEL = 'gpt-4o-mini';

export function createDb(url: string): Sql {
	return postgres(url, { max: 5 });
}

export function createEmbeddings(apiKey: string): OpenAIEmbeddings {
	return new OpenAIEmbeddings({ model: EMBEDDING_MODEL, apiKey });
}

export function createChatModel(apiKey: string, temperature = 0.2): ChatOpenAI {
	return new ChatOpenAI({ model: CHAT_MODEL, temperature, apiKey });
}
