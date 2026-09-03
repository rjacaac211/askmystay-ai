# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
docker compose up -d postgres   # pgvector/pg16; must be running for seed/dev
npm run seed                    # chunk + embed src/data/guidebook.md into Postgres (idempotent)
npm run dev                     # Vite dev server on :5173
npm run check                   # svelte-kit sync + svelte-check — the only static verification
npm run build && npm start      # adapter-node build into build/, then `node build` on :3000
npm run calibrate               # re-measure SIMILARITY_THRESHOLD against the seeded chunks
npm run graph                   # re-render docs/agent-graph.{mmd,png} from the compiled graph
docker compose up --build       # whole stack; app on :3000 (still seed from the host)
```

There is no test framework. Behavioural verification is `npm run calibrate` (a retrieval eval,
requires a seeded DB and spends OpenAI credits) plus manual exercise of the UI or `POST /api/chat`.

Re-run `npm run seed` after any edit to `src/data/guidebook.md`, then `npm run calibrate`.
Re-run `npm run graph` after any change to the graph's nodes or edges — the README embeds the PNG.

The runtime Docker image has no `tsx`, so `npm run seed` is always run from the host against the
published Postgres port. If a native Postgres owns 5432 it shadows the container mapping (symptom:
`password authentication failed`); set `POSTGRES_HOST_PORT=5433` and point `DATABASE_URL` at it.

## Architecture

A SvelteKit app whose only backend route (`src/routes/api/chat/+server.ts`) runs one turn of a
LangGraph.js agent over a single property's guidebook. The README documents each node in detail;
what follows is what you need before editing.

**Request path:** `+page.svelte` → `POST /api/chat` → `askQuestion()` in `src/lib/agent.ts` →
`contextualize` → `retrieve` → conditional edge → `generate` | `fallback` → last message returned.

**Two-layer grounding — do not collapse it into one.** `SIMILARITY_THRESHOLD` (0.15) is an
*off-topic floor*, not a relevance judgement: cosine similarity measures topical relatedness, and
the answerable/unanswerable populations overlap (a 0.3 gate drops 6 of 27 answerable questions).
Whether the retrieved excerpts actually contain the answer is decided by the model in `generate`,
which is instructed to emit `FALLBACK_ANSWER` **verbatim** when they don't. Both refusal paths emit
the identical string, and `AskResult.grounded` is a string comparison against it — so changing the
wording in one place without the other silently breaks refusal detection. Raise the threshold only
with `npm run calibrate` output to back it.

**Everything is lazy, and secrets come from `$env/dynamic/private`.** `vite build` imports every
server module for route analysis, and the Docker build stage has no keys. Constructing an OpenAI or
Postgres client at module load, or switching to `$env/static/private` (inlined at build time), makes
the build require secrets. Keep client construction inside the getters in `src/lib/server/`.

**`src/lib/chunk.ts` and `src/lib/clients.ts` are the Vite-free shared layer.** `scripts/seed.ts`
and `scripts/calibrate.ts` run under `tsx`, outside Vite, where `$env/*` and `$lib/*` do not resolve
— they import these two modules directly and read `process.env` via dotenv. Never add a `$env/*` or
`$lib/*` import to either file. `scripts/graph.mjs` needs the real `src/lib/agent.ts`, so it
installs `scripts/lib/alias-hook.mjs`, a Node resolver hook that maps those aliases; if you add a
new alias to an agent-side import, teach the hook about it.

**Conditional edges need their `pathMap`.** `addConditionalEdges('retrieve', routeAfterRetrieve,
['generate', 'fallback'])` — without the destination list LangGraph assumes every node is reachable
and `npm run graph` renders phantom edges.

**Memory** is LangGraph's `PostgresSaver` on the same database as the vectors, keyed by `thread_id`
(the browser keeps its id in `localStorage`). The full transcript is persisted; `windowed()` trims
to the last `HISTORY_WINDOW` (10) messages only when messages are *read* for a model call. `fallback`
appends both the guest message and the fixed refusal even though it makes no LLM call, so the stored
history stays a coherent alternating transcript.

**Retrieval SQL** (`src/lib/server/retrieval.ts`): `<=>` is cosine *distance*, so similarity is
`1 - distance` and ordering is ascending. Inverting this silently inverts the threshold. The
`postgres` driver has no pgvector type — embeddings go in as a parameterised literal cast `::vector`.
There is deliberately no ivfflat/HNSW index on `embedding`: ~10 rows per guidebook, where an exact
scan is faster and an ivfflat index hurts recall.

**Multi-property:** every retrieval and seed row is scoped by `property_id`. The UI currently
hardcodes `PROPERTY_ID = 'sunset-ridge-cabin'` in `+page.svelte`, and the seed script takes
`SEED_PROPERTY_ID`; the server side is already property-agnostic.

## Conventions

- Svelte 5 runes (`$state`, `$derived`, `$effect`) — not Svelte 4 stores or `export let`.
- Tabs for indentation; single quotes; TypeScript `strict`.
- Comments in this codebase explain *why* a non-obvious choice was made, and several encode
  measured results. Preserve them when refactoring the code they describe.
- The API route logs the real error server-side and returns a generic 500 — misconfiguration
  messages can name env vars and connection strings.
