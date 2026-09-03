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
  <img src="docs/agent-graph.png" alt="AskMyStay LangGraph agent: start to contextualize to retrieve, then conditionally to either generate or fallback, both ending at end" width="260">
</p>

Generated from the compiled graph itself with `npm run graph`, so it cannot drift from the code.
Dotted edges are the conditional branch. Re-run it after changing any node or edge.

- **contextualize** — rewrites a follow-up into a standalone search query using the conversation
  so far, so *"and what time is that again?"* still retrieves the right section. Skipped (no LLM
  call) on the first turn.
- **retrieve** — embeds the query and runs a pgvector cosine search scoped to `property_id`,
  returning the top 3 chunks.
- **conditional edge** — if nothing clears a cosine similarity of `0.15`, route to **fallback**.
  This is an *off-topic floor*, not a relevance judgement — see below.
- **generate** — builds a system prompt instructing the model to answer *only* from the retrieved
  excerpts, then calls `gpt-4o-mini`. If the excerpts don't contain the answer, the model is
  instructed to reply with the refusal sentence **verbatim**.
- **fallback** — returns that same sentence with no LLM call at all.

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
