# AskMyStay

A guest-facing chatbot that answers questions about a short-term rental, grounded in that
property's own guidebook via retrieval-augmented generation. If the guidebook doesn't cover
something, the agent says so and points the guest at the host — it does not guess a check-in
time or invent a wifi password.

The sample property is **Sunset Ridge Cabin**, a fictional A-frame outside Leavenworth, WA.

## Stack

- **SvelteKit + TypeScript**, Svelte 5 runes (`$state`, `$derived`, `$effect`)
- **LangGraph.js** for agent orchestration
- **PostgreSQL + pgvector** for retrieval (via the `postgres` package)
- **OpenAI** — `text-embedding-3-small` for embeddings, `gpt-4o-mini` for generation
- **Docker + docker compose**, with `adapter-node` so the app runs standalone

## Setup

You need Node 20+, Docker, and an OpenAI API key.

```bash
cp .env.example .env      # then put your real OPENAI_API_KEY in it
npm install
docker compose up -d postgres
npm run seed
npm run dev
```

Open http://localhost:5173 and ask something like *"What time is check-in?"*

`npm run seed` is idempotent — it creates the extension, tables and checkpoint tables, then
replaces the rows for that property. Re-run it whenever you edit the guidebook.

## How it works

A guidebook is `src/data/guidebook.md`, split into one chunk per `## ` section. The seed script
embeds each chunk and stores it in `guidebook_chunks` with a `vector(1536)` column.

At request time, `src/lib/agent.ts` runs this graph:

<p align="center">
  <img src="docs/agent-graph.png" alt="AskMyStay LangGraph agent: __start__ flows into contextualize, then retrieve, which branches on a dotted conditional edge to either fallback or generate, both ending at __end__" width="300">
</p>

The image is generated from the compiled graph itself by `npm run graph`, so it cannot drift from
the code. Solid arrows are unconditional edges; the dotted pair out of `retrieve` is the
conditional branch, and only one of them is taken per turn.

### Graph state

Every node receives the same state object and returns a partial update to it. LangGraph merges
each update and — because the graph is compiled with a checkpointer — persists the result under
the conversation's `thread_id`.

| Field | Type | Written by | Purpose |
| --- | --- | --- | --- |
| `messages` | `MessagesValue` | `generate`, `fallback` | The full transcript. Appended to, never truncated in storage. |
| `propertyId` | `string` | caller | Scopes retrieval so one deployment can serve many properties. |
| `question` | `string` | caller | The guest's raw wording for this turn. |
| `searchQuery` | `string` | `contextualize` | The standalone, pronoun-resolved query actually embedded. |
| `chunks` | `string[]` | `retrieve` | Up to 3 guidebook excerpts. |
| `topSimilarity` | `number` | `retrieve` | Cosine similarity of the best match, used by the router. |

`messages` uses `MessagesValue`, which appends rather than overwrites — that is what accumulates
history across turns. The other fields are plain values and are replaced each turn.

### Nodes

**`contextualize`** — resolves follow-ups.

Reads `messages` + `question`, writes `searchQuery`. A guest who asks *"and what about my cat?"*
produces a query that embeds terribly on its own and would match nothing. This node folds the
recent transcript and the new question into one self-contained query (*"Can I bring my cat?"*)
before anything is embedded.

On the first turn there is no history to resolve against, so it returns the question unchanged
and spends nothing. On later turns it costs one small `gpt-4o-mini` call.

**`retrieve`** — finds candidate excerpts.

Reads `searchQuery` and `propertyId`, writes `chunks` + `topSimilarity`. Embeds the query with
`text-embedding-3-small`, then runs a pgvector cosine search scoped to that property, taking the
top 3 by distance. Always costs one embedding call and one database query.

Note `<=>` is cosine *distance*, so similarity is `1 - distance` — see `src/lib/server/retrieval.ts`.

**`routeAfterRetrieve`** — the conditional edge (a function, not a node).

Reads `chunks` + `topSimilarity` and returns the name of the next node. If nothing was retrieved,
or the best match is below `SIMILARITY_THRESHOLD` (0.15), it routes to `fallback`; otherwise to
`generate`. Its possible destinations are declared with a `pathMap` so LangGraph knows the branch
is exactly two-way.

This is an **off-topic floor, not a relevance judgement** — the reasoning is in the next section.

**`generate`** — answers from the excerpts.

Reads `chunks`, `messages` and `question`, appends the guest message and the model's reply to
`messages`. Builds a system prompt carrying the excerpts and instructing the model to use nothing
else, then sends system + the last 10 messages + the new question to `gpt-4o-mini`.

Crucially, the model is also told that excerpts are retrieved by *topic* and may not actually
contain the answer — and that when they don't, it must reply with the refusal sentence **verbatim**.
So this node can still refuse. Costs one chat call.

**`fallback`** — refuses without asking the model.

Reads `question`, appends it plus the fixed `FALLBACK_ANSWER` to `messages`. No LLM call at all:
when retrieval finds nothing on-topic, the model never sees the question and therefore cannot
invent an answer. It still writes both messages so the persisted transcript stays a coherent
alternating history for the next turn.

Both `generate` and `fallback` lead to `__end__`, and `askQuestion` returns the last message.

### What a turn costs

Because refusal can come from either branch, cost varies. Measured against the running container:

| Turn | contextualize | embed | generate | latency |
| --- | --- | --- | --- | --- |
| First turn, off-topic | — | ✓ | — | ~0.44s |
| First turn, answered or model-refused | — | ✓ | ✓ | ~1.2s |
| Later turn, off-topic | ✓ | ✓ | — | ~0.87s |
| Later turn, answered or model-refused | ✓ | ✓ | ✓ | ~1.7s |

Both refusal paths emit the identical sentence, so a refusal is detectable from the response but
which path produced it is not.

### Why the threshold is 0.15, not 0.3

A similarity cutoff cannot decide whether an answer is present — it only measures topical
relatedness. `npm run calibrate` scores questions this guidebook *does* answer against ones it
*doesn't*, and the two populations overlap badly:

| Question | Score | In the guidebook? |
| --- | --- | --- |
| Is there a washer and dryer? | 0.3744 | **No** |
| Can I bring my cat? | 0.2849 | **Yes** |

"Washer and dryer" sits topically next to the Kitchen chunk even though laundry is absent from
it. No cutoff separates these, so a `0.3` gate silently dropped 6 of 27 answerable questions —
including "Can I bring my cat?", which the guidebook answers explicitly.

So grounding is enforced in two places, each doing what it is actually good at:

1. **The threshold** rejects questions that aren't about this property at all ("what is the
   capital of France?" scores 0.1044). Cheap, and no LLM call.
2. **The model** decides whether the retrieved excerpts genuinely contain the answer, and refuses
   verbatim when they don't.

Because both paths emit the identical sentence, a refusal is reliably detectable — that is what
`grounded` in `AskResult` reports. Re-run `npm run calibrate` after editing the guidebook.

### Memory

The agent remembers the conversation. State is persisted per `thread_id` by LangGraph's
`PostgresSaver`, using the same Postgres instance as the vectors, so history survives restarts.
Each turn replays a **sliding window of the last 10 messages** via `trimMessages` with a
message-count counter. The full transcript stays in the checkpoint; only the window is sent to
the model.

The browser keeps its `threadId` in `localStorage`, so a refresh continues the same conversation.
"Start over" issues a fresh one.

## API

```
POST /api/chat
  { "propertyId": "sunset-ridge-cabin", "threadId": "...", "question": "What time is check-in?" }
  → { "answer": "...", "threadId": "..." }
```

`threadId` is optional — omit it to start a new conversation and the server returns a generated one.

## Configuration notes

Two things here are deliberate and easy to get wrong if you refactor:

**Secrets are read through `$env/dynamic/private`, not `$env/static/private`.** The static form is
inlined at *build* time, which would bake a missing `OPENAI_API_KEY` into the Docker image. The
dynamic form is `process.env` at runtime under `adapter-node`.

**Every OpenAI and database client is constructed lazily**, inside a getter on first use, never at
module load. `vite build` imports every server module to analyse routes; constructing clients
eagerly would make the build require an API key. Together these are why `npm run build` and
`docker build` both succeed with no secrets present.

`scripts/seed.ts` runs under `tsx`, outside Vite, where the `$env/*` aliases don't resolve. It
reads `process.env` via dotenv and calls the same factories from `src/lib/clients.ts` that the app
wraps — that module is kept free of Vite-only imports on purpose.

There is intentionally **no ivfflat/HNSW index** on the embedding column. One guidebook is ~10
rows, where an exact scan is faster and an ivfflat index built on so few rows measurably hurts
recall. Add one when you're serving many properties.

## Running the whole stack in Docker

```bash
docker compose up --build
```

Postgres has a healthcheck and the app waits on `condition: service_healthy`. The app is then on
http://localhost:3000.

Seed from the host, since the runtime image is deliberately kept slim (no `tsx`, which is a dev
dependency):

```bash
npm run seed
```

If you already run Postgres natively it will own port 5432 and silently shadow the container's
mapping, so seeding fails with `password authentication failed`. Publish the container elsewhere
and point `DATABASE_URL` at the same port:

```bash
POSTGRES_HOST_PORT=5433
DATABASE_URL=postgresql://askmystay:askmystay@localhost:5433/askmystay
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | Production build (adapter-node, into `build/`) |
| `npm run preview` | Preview the production build |
| `npm start` | Run the built server — `node build` |
| `npm run seed` | Chunk, embed and load the guidebook |
| `npm run calibrate` | Re-measure the similarity threshold against the seeded chunks |
| `npm run graph` | Re-render `docs/agent-graph.png` from the compiled graph |
| `npm run check` | `svelte-kit sync` + `svelte-check` |

## Project layout

```
src/data/guidebook.md          property content, one "## " section per chunk
src/lib/chunk.ts               pure markdown → chunks (shared with the seed script)
src/lib/clients.ts             pure client factories, no $env
src/lib/server/db.ts           lazy Postgres singleton
src/lib/server/openai.ts       lazy embeddings + chat model
src/lib/server/checkpointer.ts lazy PostgresSaver (+ idempotent setup)
src/lib/server/retrieval.ts    pgvector cosine search
src/lib/agent.ts               the LangGraph graph
src/routes/api/chat/+server.ts POST endpoint
src/routes/+page.svelte        chat UI
scripts/seed.ts                one-time (idempotent) seed
scripts/calibrate.ts           re-measure the similarity threshold
scripts/graph.mjs              render the agent graph to docs/
```
