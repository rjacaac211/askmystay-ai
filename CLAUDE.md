# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The README explains what the project *is* and why each design choice was made. This file is the
short list of things that will break if you do not know them.

## Commands

```bash
docker compose up -d postgres   # pgvector/pg16; must be running for seed/dev
npm run seed                    # sync every src/data/guidebooks/*.md into Postgres (incremental)
npm run seed -- --source=strapi # same, but pull the sections from the CMS instead
npm run dev                     # Vite dev server on :5173
npm run check                   # svelte-kit sync + svelte-check — the only static verification
npm run build && npm start      # adapter-node build into build/, then `node build` on :3000
npm run calibrate               # re-measure SIMILARITY_THRESHOLD against the seeded chunks
npm run evals                   # 51 cases + 8 booking-verification checks; run after ANY prompt edit
npm run graph                   # re-render docs/agent-graph.{mmd,png} from the compiled graph
npm run demo                    # re-record docs/*.gif from the running app (needs dev + ffmpeg)
docker compose up --build       # whole stack; app on :3000 (still seed from the host)
```

There is no test framework. Behavioural verification is `npm run evals` (the regression gate) and
`npm run calibrate` (retrieval only). Both need a seeded DB and spend API credits.

Re-run `npm run seed` after any edit under `src/data/guidebooks/` or `src/data/properties/`, then
`npm run calibrate`. Re-run `npm run graph` after any change to the graph's nodes or edges — the
README embeds the PNG. Re-run `npm run demo` after any change to the chat surface — the README's
GIFs are recorded from the real app, so they go stale the same way a screenshot would.

The runtime Docker image has no `tsx`, so `npm run seed` is always run from the host against the
published Postgres port. If a native Postgres owns 5432 it shadows the container mapping (symptom:
`password authentication failed`); set `POSTGRES_HOST_PORT=5433` and point `DATABASE_URL` at it.

## The graph

**Request path:** `Chat.svelte` → `POST /api/chat/stream` → `askQuestionStream()` in
`src/lib/agent.ts` → `loadBooking` → `contextualize` → `retrieve` → conditional edge →
`generate` | `fallback`; `generate` may loop through `tools` → deltas streamed back.
`POST /api/chat` + `askQuestion()` is the same graph, non-streamed.

**Conditional edges need their `pathMap`.** `addConditionalEdges('retrieve', routeAfterRetrieve,
['generate', 'fallback'])` — without the destination list LangGraph assumes every node is reachable
and `npm run graph` renders phantom edges.

**`generate` runs twice in a tool turn.** It detects the continuation by a trailing `ToolMessage`
and on that pass appends only the AI reply, never a second copy of the question. The model's
response is stored as-is because it may carry `tool_calls`, and a tool result whose matching
`tool_use` is missing is rejected by the API. Tools are NOT bound on the continuation pass — that is
what prevents a tool loop, rather than relying on a recursion limit.

## Two sources, and when to use a tool

The guidebook (retrieved) answers questions about the *property*; the `bookings` table answers
questions about *this guest's stay*.

**`loadBooking` is deliberately not a model-callable tool.** Six fields behind a unique key:
prefetching costs one indexed read and ~80 prompt tokens where a tool call costs a round-trip plus a
route the model can get wrong.

**`request_late_checkout` is a tool, and the contrast is the point.** It writes, it has to be asked
for, and its argument comes out of natural language. It is built per turn as a closure over state
(`makeLateCheckoutTool`), which is the security boundary: the model supplies *what* and *when*,
while *whose booking* comes from `state.booking` and cannot be influenced by anything a guest says.
Tools bind only when a booking is attached.

## Grounding and refusals

**Two layers — do not collapse them into one.** `SIMILARITY_THRESHOLD` (0.15) is an *off-topic
floor*, not a relevance judgement: cosine similarity measures topical relatedness, and the
answerable/unanswerable populations overlap (a 0.3 gate drops 6 of 27 answerable questions). Whether
the excerpts actually contain the answer is decided by the model in `generate`. Raise the threshold
only with `npm run calibrate` output to back it.

**Two things bypass the floor**, both in `routeAfterRetrieve`:

- A bound booking, because a stay question scores below 0.15 against a guidebook that never mentions
  this guest. Grounding is unaffected — `generate` is still the judge — but off-topic questions then
  reach the model instead of being refused for free.
- `withheldGuestOnly`, so a guest asking for their own wifi password is told to attach a booking
  rather than getting a flat "I don't have that info".

**Refusals are exact sentinels, in `src/lib/refusals.ts`.** `FALLBACK_ANSWER` (neither source has
it) and `NO_BOOKING_ANSWER` (needs a booking that is not attached), both exported in
`REFUSAL_ANSWERS`. `AskResult.grounded` is a membership test against that array, so a third sentinel
means adding it there too; the eval suite classifies on them; the widget matches the second to offer
the booking form. They live in their own module because `agent.ts` pulls in database and model
clients and cannot be imported by the browser — a copied string in the UI would silently drift.

**Matching is normalised, not exact.** `normalizeForMatch` folds curly quotes, dashes and
whitespace. A version of `NO_BOOKING_ANSWER` that quoted the button label with curly quotes came
back from the model with straight ones — words verbatim, typography not — which broke the contract
and reclassified every refusal as a grounded answer. Keep sentinels to characters a model has no
reason to normalise, AND normalise before comparing. `mentionsNoBooking` is a normalised `includes`,
so a compound reply that answers half and refuses half still offers the form.

**Instruction order in the `generate` prompt is load-bearing.** With the refusal contract stated
before the tone instruction, off-topic questions came back as a friendly deflection instead of the
sentinel. The refusal rules come last, after the data, and explicitly forbid that shape.

**Answers must be plain prose — no markdown.** The chat bubble interpolates `{message.text}`, which
Svelte escapes, so `**cedarcreek2019**` reaches the guest with the asterisks in it. Asserted on every
eval case.

**Amenity lists are summaries, not inventories.** The prompt says so, because indexing the listing
made the model infer absence from a list ("no hot tub, the amenities are X, Y, Z") — wrong whenever
a host simply did not mention something. This has to live in the system prompt: instructions inside
retrieved content are ignored by design.

## Untrusted input

**Retrieved content rides in the user turn, fenced — not the system prompt.** Guidebook text is
host-authored through a CMS, so it is untrusted input reaching the model on every retrieval. Moving
it back into the system message would hand whatever a host typed the same authority as our own
rules. `generate` persists the guest's *plain* question, not the fenced wrapper: storing the wrapper
would grow the history window with stale excerpts and re-inject old content every turn.

**Guest-only content is withheld in SQL, not in the prompt.** A section marked `<!-- guest-only -->`
in its markdown (`guest_only` in the row) is excluded from `searchChunks` unless a booking is
attached — wifi passwords and door codes are the case this exists for. Content the model never
receives cannot be argued, tricked or injected out of it.

`searchChunks` reports `withheldGuestOnly` when a restricted section would have out-ranked what it
returned; that adds a note to the fenced context, and only then, or the model starts blaming a
missing booking for every question it cannot answer.

**The chunk hash covers visibility as well as text** (`sync.ts`). Marking an existing section
guest-only changes no words, so hashing content alone would report it `unchanged` and leave the old
public row in place.

**Attaching a stay takes reference AND surname** (`POST /api/booking/verify`). A reference alone is a
bearer token. The endpoint returns an identical `{ok:false}` for "no such reference" and "wrong
surname", with a 200 so the status code is not a signal either, and rate limits per IP. The limiter
is in-process and therefore per-instance; behind a load balancer it needs a shared store.

## Content pipeline

**Source-pluggable, and reindexing is a diff.** `src/lib/content.ts` defines `ContentSection`
(`sourceId`, `heading`, `content`, `guestOnly`); a source only has to produce those.
`sectionsFromMarkdown` reads the files, `fetchStrapiSections` reads the CMS, and both render the
heading followed by the body identically, so they embed into the same space and the calibrated
threshold holds either way. `src/lib/sync.ts` hashes each section, diffs against the stored
`content_hash`, and embeds only what changed. `sourceId` is the section's *identity*, not its text,
which is what makes an edit an `update` rather than a delete-plus-add.

**Multi-property is file-driven.** Every `src/data/guidebooks/<property-id>.md` is one property: the
filename is the `property_id` that scopes retrieval, the single `# ` title is the display name. No
registry to drift out of sync.

**Listings are separate but indexed.** `src/data/properties/<id>.json` holds catalogue copy;
`listingToSection` indexes it as one more chunk so the assistant can answer anything the page
states. Stored in `properties.listing` as jsonb via `sql.json()` — a stringified literal cast to
`::jsonb` double-encodes, because the driver already JSON-encodes a parameter bound to a jsonb
column, and the row ends up holding a JSON *string*.

**Visibility is part of the content, everywhere.** `guest_only` travels through BOTH sources: the
`<!-- guest-only -->` marker in markdown, and a `guestOnly` boolean on the Strapi content type.
Leaving it off the CMS meant a reindex republished every restricted section as public — the wifi
password stopped being withheld the moment a host edited anything, a security regression arriving
through a content change. `POST /api/reindex` also re-appends `listingToSection` from the stored
property row, or a webhook deletes the listing chunk and the page goes on saying "2 bedrooms" while
the assistant refuses to say how many there are.

**Strapi lives in `strapi/`, as its own package.** Content types are checked-in `schema.json` files.
`strapi/src/index.ts` bootstraps a fresh instance: public read-only access, one property per
guidebook file, and the `askmystay-reindex` webhook. `WEBHOOKS_POPULATE_RELATIONS` must stay `true`:
`POST /api/reindex` reads `entry.property.slug`. Strapi's `splitSections` is a deliberate small copy
of the chunker — demo seeding only, never on the indexing path.

**`POST /api/reindex`** is gated on a constant-time compare of `x-reindex-secret` and refuses (503)
when unset rather than defaulting to open.

## UI

**`src/lib/components/Chat.svelte` is shared by the listing page and the widget.** One component so
the two cannot drift; `compact` changes chrome and spacing only, never behaviour.

**The identify step.** The widget opens asking *Just browsing* or *I have a booking*. A guest
arriving on a host's link (`?booking=`) skips it — making them retype a reference they were just
texted is worse UX, not better security. That URL path is still a bearer token; a real deployment
wants a short-lived signed link.

**Routes:** `/` is the catalogue, `/p/[propertyId]` the listing page, `/embed/[propertyId]` the chat.
The listing page loads the assistant with a plain `<script src="/widget.js">` tag and imports no chat
code, so it exercises the real embed path. `/embed` is the only route that sets `frame-ancestors`,
from `EMBED_ORIGINS`, defaulting to `'self'`.

**The listing page is deliberately thin** — facts, description, three highlights, a nudge. Amenities
and house rules are in the listing JSON and ARE indexed; they are simply not printed, because a page
that answers everything makes the assistant redundant on its own page.

**Streaming: `askQuestionStream` yields deltas and RETURNS the AskResult.** Two filters are
load-bearing. `langgraph_node === 'generate'` drops `contextualize`'s output, which is a rewritten
search query. `getType() === 'ai'` drops the guest's own question: `messages` stream mode emits
everything a node puts on state, and `generate` appends the HumanMessage, so without it the question
is concatenated onto the answer. And `fallback` makes no model call, so a refused turn streams
nothing — the sentinel is read off persisted state and yielded whole.

## Memory and retrieval

**Memory** is LangGraph's `PostgresSaver` on the same database as the vectors, keyed by `thread_id`
(the browser keeps its id in `localStorage`, scoped to property AND stay). The full transcript is
persisted; `windowed()` trims to the last `HISTORY_WINDOW` (10) messages only when messages are
*read* for a model call. `fallback` appends both the guest message and the refusal even though it
makes no LLM call, so the stored history stays a coherent alternating transcript.

**Retrieval SQL** (`src/lib/server/retrieval.ts`): `<=>` is cosine *distance*, so similarity is
`1 - distance` and ordering is ascending. Inverting this silently inverts the threshold. The
`postgres` driver has no pgvector type — embeddings go in as a parameterised literal cast `::vector`.
There is deliberately no ivfflat/HNSW index on `embedding`: ~10 rows per guidebook, where an exact
scan is faster and an ivfflat index hurts recall.

## Configuration

**Generation is provider-agnostic; embeddings are not.** `LLM_PROVIDER` (default `anthropic`) picks
who writes answers, via `createChatModel` in `src/lib/clients.ts`; `src/lib/server/models.ts` holds
the lazy getters (`getChatModel` for answers, `getUtilityModel` for the cheap rewrite in
`contextualize`). Anthropic has no embeddings endpoint, so retrieval stays on OpenAI and
`OPENAI_API_KEY` is required on both paths. Do not swap the embedding model: `SIMILARITY_THRESHOLD`
was measured against `text-embedding-3-small` vectors.

**Everything is lazy, and secrets come from `$env/dynamic/private`.** `vite build` imports every
server module for route analysis, and the Docker build stage has no keys. Constructing a client at
module load, or switching to `$env/static/private` (inlined at build time), makes the build require
secrets. Keep client construction inside the getters in `src/lib/server/`.

**The Vite-free shared layer** is `src/lib/chunk.ts`, `clients.ts`, `content.ts`, `sync.ts`,
`listing.ts`, `refusals.ts` and `strapi.ts`. Scripts under `scripts/` run under `tsx`, outside Vite,
where `$env/*` and `$lib/*` do not resolve — they import these directly and read `process.env` via
dotenv. Never add a `$env/*` or `$lib/*` import to any of them. `scripts/graph.mjs` and
`scripts/evals.ts` need the real `src/lib/agent.ts`, so they install `scripts/lib/alias-hook.mjs`, a
Node resolver hook that maps those aliases; teach the hook about any new alias.

## Evals

**`npm run evals` is the regression gate. Run it after ANY prompt edit.** `calibrate` measures
retrieval; `evals` measures answers. It runs the real graph against a seeded DB, seeds and tears
down its own poisoned property and late-checkout rows, and exits non-zero on failure.

It exists because prompt changes do not stay local: hardening the refusal rules to stop an off-topic
deflection silently broke "What time is check-in?" on the no-booking path.

Three rules for writing cases here, each learned from a case that went red:

- **Never pin one reading of an ambiguous question.** "When do I check out?" means either "what is
  the check-out time here?" or "what is MY check-out date?", and the model picks differently across
  runs. Ask unambiguously, and assert what actually matters (no fabricated date) separately.
- **Cover the path the UI uses.** Everything else exercises `askQuestion` while the UI streams; that
  gap let the streaming path concatenate the question onto the answer.
- **Do not truncate an answer before asserting on it.** That is what hid the bug above.

## Conventions

- Svelte 5 runes (`$state`, `$derived`, `$effect`) — not Svelte 4 stores or `export let`.
- Tabs for indentation; single quotes; TypeScript `strict`.
- Comments in this codebase explain *why* a non-obvious choice was made, and several encode
  measured results. Preserve them when refactoring the code they describe.
- API routes log the real error server-side and return a generic message — misconfiguration
  messages can name env vars and connection strings.
- Voice / TTS / STT is out of scope by choice. Do not add it, and do not flag its absence as a gap.
