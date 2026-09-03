import {
	StateGraph,
	StateSchema,
	MessagesValue,
	START,
	END,
	type GraphNode,
	type ConditionalEdgeRouter
} from '@langchain/langgraph';
import { AIMessage, HumanMessage, SystemMessage, trimMessages } from '@langchain/core/messages';
import * as z from 'zod';

import { getDb } from './server/db';
import { getChatModel, getEmbeddings } from './server/openai';
import { ensureCheckpointerReady } from './server/checkpointer';
import { searchChunks } from './server/retrieval';

/**
 * Off-topic floor - NOT a relevance judgement.
 *
 * Calibrated with `npm run calibrate` against this guidebook. Cosine similarity
 * measures topical relatedness, not whether an answer is actually present, so it
 * cannot decide groundedness on its own. Measured over 42 questions the two
 * populations overlap badly:
 *
 *   "Is there a washer and dryer?"  0.3744  <- NOT in the guidebook
 *   "Can I bring my cat?"           0.2849  <- IS in the guidebook
 *
 * "Washer and dryer" sits topically next to the Kitchen chunk even though
 * laundry is absent from it, so no cutoff separates these. A 0.3 gate silently
 * dropped 6 of 27 answerable questions, the cat one included.
 *
 * This value therefore does only the job cosine can do: reject questions that
 * are not about this property at all ("what is the capital of France?" 0.1044,
 * "tell me a joke" 0.1194). At 0.15 every answerable question survives.
 * Deciding whether the excerpts actually contain the answer is the model's job
 * - see `generate`, which is instructed to refuse verbatim.
 */
export const SIMILARITY_THRESHOLD = 0.15;

/** Sliding window: the last N messages are replayed to the model each turn. */
export const HISTORY_WINDOW = 10;

export const FALLBACK_ANSWER =
	"I don't have that info, please contact your host.";

const AgentState = new StateSchema({
	// Full transcript. The checkpointer persists this per thread_id; the window
	// is applied when messages are READ, so the stored history stays complete.
	messages: MessagesValue,
	propertyId: z.string(),
	question: z.string(),
	/** Standalone, context-resolved query actually used for embedding. */
	searchQuery: z.string().default(''),
	chunks: z.array(z.string()).default(() => []),
	topSimilarity: z.number().default(0)
});

type AgentStateType = typeof AgentState.State;

/** Last N messages. `tokenCounter: (m) => m.length` makes this a message-count window. */
function windowed(messages: AgentStateType['messages']) {
	return trimMessages(messages, {
		strategy: 'last',
		maxTokens: HISTORY_WINDOW,
		tokenCounter: (msgs) => msgs.length,
		startOn: 'human',
		allowPartial: false
	});
}

/**
 * Turn a possibly-elliptical follow-up into a standalone search query.
 *
 * "and what time is that again?" embeds badly on its own and would miss every
 * chunk, tripping the fallback. On the first turn there is no history to
 * resolve against, so this short-circuits and spends no tokens.
 */
const contextualize: GraphNode<typeof AgentState> = async (state) => {
	const history = await windowed(state.messages);

	if (history.length === 0) {
		return { searchQuery: state.question };
	}

	const transcript = history
		.map((m) => `${m.getType() === 'human' ? 'Guest' : 'Assistant'}: ${m.text}`)
		.join('\n');

	const response = await getChatModel().invoke([
		new SystemMessage(
			'Rewrite the guest\'s latest question as a standalone search query for a ' +
				'rental property guidebook. Resolve pronouns and implicit references using ' +
				'the conversation. Reply with the query only — no preamble, no quotes. If ' +
				'the question already stands alone, return it unchanged.'
		),
		new HumanMessage(
			`Conversation so far:\n${transcript}\n\nLatest question: ${state.question}\n\nStandalone query:`
		)
	]);

	const rewritten = response.text.trim();
	return { searchQuery: rewritten.length > 0 ? rewritten : state.question };
};

const retrieve: GraphNode<typeof AgentState> = async (state) => {
	const query = state.searchQuery || state.question;
	const embedding = await getEmbeddings().embedQuery(query);
	const results = await searchChunks(getDb(), state.propertyId, embedding, 3);

	return {
		chunks: results.map((r) => r.content),
		topSimilarity: results.length > 0 ? results[0].similarity : 0
	};
};

/**
 * Gate the LLM behind retrieval quality. If nothing clears the threshold the
 * model never sees the question, so it cannot invent a check-in time.
 */
const routeAfterRetrieve: ConditionalEdgeRouter<{
	InputSchema: typeof AgentState;
	Nodes: 'generate' | 'fallback';
}> = (state) => {
	if (state.chunks.length === 0 || state.topSimilarity < SIMILARITY_THRESHOLD) {
		return 'fallback';
	}
	return 'generate';
};

const generate: GraphNode<typeof AgentState> = async (state) => {
	const excerpts = state.chunks
		.map((c, i) => `--- Excerpt ${i + 1} ---\n${c}`)
		.join('\n\n');

	const system = new SystemMessage(
		'You are the assistant for a short-term rental, answering questions from the ' +
			'guest currently staying there.\n\n' +
			'Answer ONLY using the guidebook excerpts below. Do not use outside knowledge ' +
			'and do not guess.\n\n' +
			'The excerpts are retrieved by topic similarity, so they are frequently about ' +
			'a related subject without actually containing the answer. Judge that honestly: ' +
			'a nearby topic is not an answer. If the excerpts do not contain it, reply with ' +
			'EXACTLY this sentence and nothing else:\n' +
			`${FALLBACK_ANSWER}\n\n` +
			'Replying verbatim matters — it is how the app tells a real answer from a ' +
			'refusal. Never reword or approximate it.\n\n' +
			'Be warm, direct, and brief: two or three sentences unless the guest asks for ' +
			'detail. Give specifics (times, codes, days) exactly as written. Do not mention ' +
			'"excerpts", "documents", or "the guidebook" — just answer naturally.\n\n' +
			`Guidebook excerpts:\n${excerpts}`
	);

	const history = await windowed(state.messages);
	const question = new HumanMessage(state.question);

	const response = await getChatModel().invoke([system, ...history, question]);

	return { messages: [question, new AIMessage(response.text)] };
};

/**
 * Declines without an LLM call. Still appends both messages so the persisted
 * transcript stays a coherent alternating history for the next turn.
 */
const fallback: GraphNode<typeof AgentState> = (state) => ({
	messages: [new HumanMessage(state.question), new AIMessage(FALLBACK_ANSWER)]
});

export const builder = new StateGraph(AgentState)
	.addNode('contextualize', contextualize)
	.addNode('retrieve', retrieve)
	.addNode('generate', generate)
	.addNode('fallback', fallback)
	.addEdge(START, 'contextualize')
	.addEdge('contextualize', 'retrieve')
	// The pathMap declares the only destinations this router can return. Without
	// it LangGraph assumes every node is reachable and the rendered graph shows
	// phantom edges (retrieve -> contextualize, retrieve -> END).
	.addConditionalEdges('retrieve', routeAfterRetrieve, ['generate', 'fallback'])
	.addEdge('generate', END)
	.addEdge('fallback', END);

export interface AskOptions {
	propertyId: string;
	threadId: string;
	question: string;
}

export interface AskResult {
	answer: string;
	threadId: string;
	grounded: boolean;
}

let _graph: ReturnType<typeof builder.compile> | null = null;

/** Compiled once and reused — compilation validates the topology and is not free. */
async function getGraph() {
	if (!_graph) {
		const checkpointer = await ensureCheckpointerReady();
		_graph = builder.compile({ checkpointer });
	}
	return _graph;
}

/**
 * Run one turn. Prior messages for `threadId` are restored by the checkpointer,
 * so the caller only ever sends the new question.
 */
export async function askQuestion({
	propertyId,
	threadId,
	question
}: AskOptions): Promise<AskResult> {
	const graph = await getGraph();

	const result = await graph.invoke(
		{ propertyId, question },
		{ configurable: { thread_id: threadId } }
	);

	const last = result.messages.at(-1);
	const answer = last?.text ?? FALLBACK_ANSWER;

	return { answer, threadId, grounded: answer !== FALLBACK_ANSWER };
}
