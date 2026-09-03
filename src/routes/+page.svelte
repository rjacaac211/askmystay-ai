<script lang="ts">
	interface Message {
		role: 'guest' | 'assistant';
		text: string;
	}

	const PROPERTY_ID = 'sunset-ridge-cabin';
	const PROPERTY_NAME = 'Sunset Ridge Cabin';
	const THREAD_KEY = 'askmystay:threadId';

	let messages = $state<Message[]>([]);
	let input = $state('');
	let loading = $state(false);
	let errorMessage = $state('');
	let listEl = $state<HTMLDivElement | null>(null);

	// Not $state: nothing in the template reads it, so making it reactive would
	// only buy an init effect we don't need.
	let threadId: string | null = null;

	const canSend = $derived(input.trim().length > 0 && !loading);

	const suggestions = [
		'What time is check-in?',
		'What is the wifi password?',
		'When is trash day?',
		'Where should we eat dinner?'
	];

	function rememberThread(id: string) {
		try {
			localStorage.setItem(THREAD_KEY, id);
		} catch {
			// non-fatal: the conversation just won't survive a refresh
		}
	}

	/**
	 * Reuse the guest's thread across reloads so follow-ups keep their context.
	 * Resolved on first send rather than on mount — it only touches browser APIs
	 * that way, and localStorage can throw in private windows.
	 */
	function getThreadId(): string {
		if (threadId) return threadId;
		let stored: string | null = null;
		try {
			stored = localStorage.getItem(THREAD_KEY);
		} catch {
			stored = null;
		}
		threadId = stored ?? crypto.randomUUID();
		if (!stored) rememberThread(threadId);
		return threadId;
	}

	// Keep the newest message in view as the transcript grows.
	$effect(() => {
		messages.length;
		loading;
		if (listEl) listEl.scrollTop = listEl.scrollHeight;
	});

	async function send(question: string) {
		const trimmed = question.trim();
		if (trimmed === '' || loading) return;

		errorMessage = '';
		messages.push({ role: 'guest', text: trimmed });
		input = '';
		loading = true;

		try {
			const response = await fetch('/api/chat', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					propertyId: PROPERTY_ID,
					threadId: getThreadId(),
					question: trimmed
				})
			});

			if (!response.ok) {
				const detail = await response.json().catch(() => null);
				throw new Error(detail?.message ?? `Request failed (${response.status})`);
			}

			const data = await response.json();
			if (data.threadId && data.threadId !== threadId) {
				threadId = data.threadId;
				rememberThread(data.threadId);
			}
			messages.push({ role: 'assistant', text: data.answer });
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Something went wrong.';
		} finally {
			loading = false;
		}
	}

	function onsubmit(event: SubmitEvent) {
		event.preventDefault();
		send(input);
	}

	function startOver() {
		messages = [];
		errorMessage = '';
		threadId = crypto.randomUUID();
		rememberThread(threadId);
	}
</script>

<svelte:head>
	<title>AskMyStay — {PROPERTY_NAME}</title>
	<meta name="description" content="Ask anything about your stay at {PROPERTY_NAME}." />
</svelte:head>

<div class="app">
	<header>
		<div>
			<h1>AskMyStay</h1>
			<p class="property">{PROPERTY_NAME}</p>
		</div>
		{#if messages.length > 0}
			<button class="reset" onclick={startOver} disabled={loading}>Start over</button>
		{/if}
	</header>

	<div class="transcript" bind:this={listEl}>
		{#if messages.length === 0}
			<div class="empty">
				<p class="empty-title">Hi! Ask me anything about the cabin.</p>
				<p class="empty-body">
					I answer from this property's guidebook — check-in, wifi, parking, the
					thermostat, trash day, and what's good nearby.
				</p>
				<div class="suggestions">
					{#each suggestions as suggestion (suggestion)}
						<button class="chip" onclick={() => send(suggestion)} disabled={loading}>
							{suggestion}
						</button>
					{/each}
				</div>
			</div>
		{/if}

		{#each messages as message, i (i)}
			<div class="row {message.role}">
				<div class="bubble">{message.text}</div>
			</div>
		{/each}

		{#if loading}
			<div class="row assistant">
				<div class="bubble typing" aria-label="Assistant is typing">
					<span></span><span></span><span></span>
				</div>
			</div>
		{/if}
	</div>

	{#if errorMessage}
		<p class="error" role="alert">{errorMessage}</p>
	{/if}

	<form {onsubmit}>
		<input
			bind:value={input}
			placeholder="Ask about check-in, wifi, parking…"
			aria-label="Your question"
			autocomplete="off"
			maxlength="1000"
			disabled={loading}
		/>
		<button type="submit" disabled={!canSend}>Send</button>
	</form>
</div>

<style>
	:global(body) {
		margin: 0;
		background: #f5f3f0;
		color: #24201d;
		font-family:
			ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial,
			sans-serif;
	}

	.app {
		display: flex;
		flex-direction: column;
		max-width: 46rem;
		height: 100dvh;
		margin: 0 auto;
		padding: 1rem;
		box-sizing: border-box;
		gap: 0.75rem;
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding-bottom: 0.75rem;
		border-bottom: 1px solid #e2dcd5;
	}

	h1 {
		margin: 0;
		font-size: 1.15rem;
		letter-spacing: -0.01em;
	}

	.property {
		margin: 0.15rem 0 0;
		font-size: 0.85rem;
		color: #7c7169;
	}

	.reset {
		flex-shrink: 0;
		padding: 0.4rem 0.7rem;
		font-size: 0.8rem;
		color: #7c7169;
		background: transparent;
		border: 1px solid #ddd5cc;
		border-radius: 0.5rem;
		cursor: pointer;
	}

	.reset:hover:not(:disabled) {
		background: #ece7e1;
	}

	.transcript {
		flex: 1;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		padding: 0.25rem;
		scroll-behavior: smooth;
	}

	.empty {
		margin: auto 0;
		text-align: center;
		padding: 1rem;
	}

	.empty-title {
		margin: 0 0 0.4rem;
		font-size: 1.05rem;
		font-weight: 600;
	}

	.empty-body {
		margin: 0 auto 1.25rem;
		max-width: 28rem;
		font-size: 0.9rem;
		line-height: 1.5;
		color: #7c7169;
	}

	.suggestions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		justify-content: center;
	}

	.chip {
		padding: 0.4rem 0.75rem;
		font-size: 0.82rem;
		color: #4a423c;
		background: #fff;
		border: 1px solid #ddd5cc;
		border-radius: 999px;
		cursor: pointer;
	}

	.chip:hover:not(:disabled) {
		border-color: #b4531f;
		color: #b4531f;
	}

	.row {
		display: flex;
	}

	.row.guest {
		justify-content: flex-end;
	}

	.row.assistant {
		justify-content: flex-start;
	}

	.bubble {
		max-width: 82%;
		padding: 0.6rem 0.85rem;
		border-radius: 1rem;
		font-size: 0.93rem;
		line-height: 1.5;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.guest .bubble {
		background: #b4531f;
		color: #fff;
		border-bottom-right-radius: 0.25rem;
	}

	.assistant .bubble {
		background: #fff;
		border: 1px solid #e6e0d9;
		border-bottom-left-radius: 0.25rem;
	}

	.typing {
		display: flex;
		gap: 0.25rem;
		align-items: center;
	}

	.typing span {
		width: 0.4rem;
		height: 0.4rem;
		border-radius: 50%;
		background: #b8aca2;
		animation: blink 1.3s infinite ease-in-out;
	}

	.typing span:nth-child(2) {
		animation-delay: 0.18s;
	}

	.typing span:nth-child(3) {
		animation-delay: 0.36s;
	}

	@keyframes blink {
		0%,
		80%,
		100% {
			opacity: 0.3;
		}
		40% {
			opacity: 1;
		}
	}

	.error {
		margin: 0;
		padding: 0.55rem 0.75rem;
		font-size: 0.85rem;
		color: #8d2f2f;
		background: #fbeaea;
		border: 1px solid #f0cfcf;
		border-radius: 0.5rem;
	}

	form {
		display: flex;
		gap: 0.5rem;
	}

	input {
		flex: 1;
		min-width: 0;
		padding: 0.7rem 0.85rem;
		font-size: 0.95rem;
		font-family: inherit;
		color: inherit;
		background: #fff;
		border: 1px solid #ddd5cc;
		border-radius: 0.7rem;
	}

	input:focus {
		outline: 2px solid #b4531f;
		outline-offset: -1px;
	}

	form button {
		padding: 0.7rem 1.15rem;
		font-size: 0.92rem;
		font-weight: 600;
		font-family: inherit;
		color: #fff;
		background: #b4531f;
		border: none;
		border-radius: 0.7rem;
		cursor: pointer;
	}

	form button:disabled {
		background: #ccc2b8;
		cursor: not-allowed;
	}

	form button:hover:not(:disabled) {
		background: #9a4519;
	}

	@media (prefers-color-scheme: dark) {
		:global(body) {
			background: #1a1715;
			color: #ece7e1;
		}

		header {
			border-bottom-color: #332e2a;
		}

		.property,
		.empty-body {
			color: #a2968c;
		}

		.assistant .bubble {
			background: #262220;
			border-color: #383230;
		}

		.chip,
		input {
			background: #262220;
			border-color: #3d3735;
			color: #ece7e1;
		}

		.reset {
			border-color: #3d3735;
			color: #a2968c;
		}

		.reset:hover:not(:disabled) {
			background: #262220;
		}

		.error {
			color: #f0b4b4;
			background: #3a2020;
			border-color: #5a2f2f;
		}
	}
</style>
