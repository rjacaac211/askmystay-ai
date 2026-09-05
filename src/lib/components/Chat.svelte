<script lang="ts">
	/**
	 * The chat surface, shared by the full page (/p/[propertyId]) and the
	 * embeddable widget (/embed/[propertyId]).
	 *
	 * One component so the two cannot drift: a fix to the streaming logic or the
	 * error handling lands on both. `compact` only changes chrome and spacing —
	 * never behaviour.
	 */
	import { untrack } from 'svelte';

	import { mentionsNoBooking } from '$lib/refusals';

	interface Message {
		role: 'guest' | 'assistant';
		text: string;
	}

	interface Props {
		propertyId: string;
		propertyName: string;
		/**
		 * Pre-attached stay, from a link the host sent. Skips the identify step —
		 * making a guest retype a reference they were just texted is worse UX, not
		 * better security.
		 */
		bookingRef?: string;
		/** Widget mode: drop the header and tighten spacing for a small frame. */
		compact?: boolean;
	}

	let { propertyId, propertyName, bookingRef = '', compact = false }: Props = $props();

	/**
	 * Who is asking.
	 *
	 * 'choosing'  — opened cold; hasn't said whether they have a stay
	 * 'browsing'  — explicitly just looking; property questions only
	 * 'attached'  — a verified booking is bound to this conversation
	 *
	 * A guest who arrives on a host link starts attached and never sees the choice.
	 */
	// untrack makes the snapshot explicit: these seed from a prop that cannot
	// change without a navigation, and both must stay writable afterwards, so
	// $derived is not an option.
	let mode = $state<'choosing' | 'browsing' | 'attached'>(
		untrack(() => (bookingRef ? 'attached' : 'choosing'))
	);

	/** The ref actually in force — from the URL, or verified through the form. */
	let activeRef = $state(untrack(() => bookingRef));
	let guestName = $state('');

	// Booking form
	let formOpen = $state(false);
	let formRef = $state('');
	let formSurname = $state('');
	let formError = $state('');
	let verifying = $state(false);

	let messages = $state<Message[]>([]);
	let input = $state('');
	let loading = $state(false);
	let errorMessage = $state('');
	let listEl = $state<HTMLDivElement | null>(null);

	// Not $state: nothing in the template reads it, so making it reactive would
	// only buy an init effect we don't need.
	let threadId: string | null = null;

	const canSend = $derived(input.trim().length > 0 && !loading);
	const canVerify = $derived(formRef.trim() !== '' && formSurname.trim() !== '' && !verifying);

	// Scoped to property AND stay: two bookings are two conversations, and two
	// properties are certainly not the same one.
	const threadKey = $derived(`askmystay:threadId:${propertyId}:${activeRef || 'anon'}`);

	const suggestions = $derived(
		activeRef
			? ['When do I check out?', 'What is the wifi password?', 'Can I get a late check-out?']
			: ['What time is check-in?', 'What is the wifi password?', 'Where should we eat dinner?']
	);

	/**
	 * True when the last answer was the "no booking attached" refusal.
	 *
	 * Compared against the shared constant rather than a copy of the string, so a
	 * reworded refusal cannot silently stop offering the form. This turns a dead
	 * end into the next step: the guest asked something only their reservation can
	 * answer, so offer to attach it right there.
	 */
	const offerBooking = $derived(
		!activeRef &&
			messages.at(-1)?.role === 'assistant' &&
			mentionsNoBooking(messages.at(-1)?.text ?? '')
	);

	function rememberThread(id: string) {
		try {
			localStorage.setItem(threadKey, id);
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
			stored = localStorage.getItem(threadKey);
		} catch {
			stored = null;
		}
		threadId = stored ?? crypto.randomUUID();
		if (!stored) rememberThread(threadId);
		return threadId;
	}

	async function verify() {
		if (!canVerify) return;
		verifying = true;
		formError = '';

		try {
			const response = await fetch('/api/booking/verify', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					propertyId,
					bookingRef: formRef.trim(),
					surname: formSurname.trim()
				})
			});

			if (response.status === 429) {
				formError = 'Too many attempts. Please wait a minute and try again.';
				return;
			}
			if (!response.ok) {
				formError = 'Something went wrong checking that. Please try again.';
				return;
			}

			const data = await response.json();
			if (!data.ok) {
				// Same message whichever half was wrong — the server does not say
				// which, and neither should we.
				formError = "We couldn't find that booking. Check the reference and surname.";
				return;
			}

			activeRef = data.bookingRef;
			guestName = data.guestName ?? '';
			mode = 'attached';
			formOpen = false;
			formRef = '';
			formSurname = '';
			// A new stay is a new conversation: the previous thread was answered
			// without a booking and should not be replayed as if it had one.
			threadId = null;
			messages = [];
		} catch {
			formError = 'Something went wrong checking that. Please try again.';
		} finally {
			verifying = false;
		}
	}

	function browseAsGuest() {
		mode = 'browsing';
	}

	function openForm() {
		formOpen = true;
		formError = '';
	}

	// Keep the newest message in view as the transcript grows — including while
	// tokens stream into the last bubble.
	$effect(() => {
		messages.length;
		messages.at(-1)?.text;
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

		// The bubble the answer streams into. Created empty and appended once the
		// first delta lands, so a failed request leaves no orphan bubble behind.
		let answerIndex = -1;

		try {
			const response = await fetch('/api/chat/stream', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					propertyId,
					threadId: getThreadId(),
					bookingRef: activeRef || undefined,
					question: trimmed
				})
			});

			if (!response.ok || !response.body) {
				const detail = await response.json().catch(() => null);
				throw new Error(detail?.message ?? `Request failed (${response.status})`);
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			// SSE frames are separated by a blank line and can be split across
			// network chunks, so hold a buffer and only consume whole frames.
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const frames = buffer.split('\n\n');
				buffer = frames.pop() ?? '';

				for (const frame of frames) {
					const line = frame.split('\n').find((l) => l.startsWith('data: '));
					if (!line) continue;

					let event: { type?: string; text?: string; threadId?: string; message?: string };
					try {
						event = JSON.parse(line.slice(6));
					} catch {
						continue;
					}

					if (event.type === 'delta' && typeof event.text === 'string') {
						if (answerIndex === -1) {
							messages.push({ role: 'assistant', text: event.text });
							answerIndex = messages.length - 1;
							// The answer is arriving, so the typing dots have done their job.
							loading = false;
						} else {
							messages[answerIndex].text += event.text;
						}
					} else if (event.type === 'done') {
						if (event.threadId && event.threadId !== threadId) {
							threadId = event.threadId;
							rememberThread(event.threadId);
						}
					} else if (event.type === 'error') {
						throw new Error(event.message ?? 'Something went wrong.');
					}
				}
			}
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Something went wrong.';
			// Drop a half-written bubble rather than leaving a truncated answer that
			// reads as if the assistant said it on purpose.
			if (answerIndex !== -1) messages.splice(answerIndex, 1);
		} finally {
			loading = false;
		}
	}

	function onsubmit(event: SubmitEvent) {
		event.preventDefault();
		send(input);
	}

	export function startOver() {
		messages = [];
		errorMessage = '';
		threadId = crypto.randomUUID();
		rememberThread(threadId);
	}
</script>

{#snippet bookingForm(heading: string)}
	<div class="identify">
		<p class="identify-title">{heading}</p>
		<label>
			<span>Booking reference</span>
			<input bind:value={formRef} placeholder="e.g. BK-4471" autocomplete="off" maxlength="64" />
		</label>
		<label>
			<span>Surname on the booking</span>
			<input bind:value={formSurname} placeholder="e.g. Moreau" autocomplete="family-name" maxlength="120" />
		</label>
		{#if formError}
			<p class="identify-error" role="alert">{formError}</p>
		{/if}
		<div class="identify-actions">
			<button class="primary" onclick={verify} disabled={!canVerify}>
				{verifying ? 'Checking…' : 'Attach my stay'}
			</button>
			<button class="ghost" onclick={() => { formOpen = false; mode = 'browsing'; }}>
				Not now
			</button>
		</div>
	</div>
{/snippet}

<div class="app" class:compact>
	{#if !compact}
		<header>
			<div>
				<h1>AskMyStay</h1>
				<p class="property">
					{propertyName}
					{#if activeRef}
						<span class="stay" title="This conversation is attached to a reservation"
							>· stay {activeRef}{guestName ? ` · ${guestName}` : ''}</span
						>
					{/if}
				</p>
			</div>
			{#if messages.length > 0}
				<button class="reset" onclick={startOver} disabled={loading}>Start over</button>
			{/if}
		</header>
	{/if}

	<div class="transcript" bind:this={listEl}>
		{#if mode === 'choosing'}
			<div class="empty">
				{#if formOpen}
					{@render bookingForm('Enter your booking')}
				{:else}
					<p class="empty-title">Hi! Ask me anything about {propertyName}.</p>
					<p class="empty-body">
						I can answer from this property's guidebook. If you have a booking here, attach it
						and I can also answer about your own stay — your dates, your unit, late check-out.
					</p>
					<div class="identify-actions">
						<button class="primary" onclick={openForm}>I have a booking</button>
						<button class="ghost" onclick={browseAsGuest}>Just browsing</button>
					</div>
				{/if}
			</div>
		{:else if messages.length === 0}
			<div class="empty">
				<p class="empty-title">Hi! Ask me anything about {propertyName}.</p>
				<p class="empty-body">
					I answer from this property's guidebook{activeRef ? ' and your booking' : ''} —
					check-in, wifi, parking, the heating, trash day, and what's good nearby.
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

		<!-- The refusal is a dead end unless we do something with it: the guest just
		     asked something only their reservation can answer, so offer it here. -->
		{#if offerBooking && !formOpen}
			<div class="offer">
				<button class="primary" onclick={openForm}>Attach my booking</button>
			</div>
		{/if}
		{#if offerBooking && formOpen}
			{@render bookingForm('Enter your booking')}
		{/if}
	</div>

	{#if errorMessage}
		<p class="error" role="alert">{errorMessage}</p>
	{/if}

	{#if mode !== 'choosing'}
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
	{/if}
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

	/* Widget mode: fill whatever frame the host page gave us, and drop the
	   page-level margins that only make sense on a standalone page. */
	.app.compact {
		max-width: none;
		padding: 0.75rem;
		gap: 0.5rem;
	}

	/* Identify step: who is asking, before anything is asked. */
	.identify {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		text-align: left;
		max-width: 22rem;
		margin: 0 auto;
	}

	.identify-title {
		margin: 0;
		font-weight: 600;
		font-size: 0.95rem;
	}

	.identify label {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: 0.8rem;
		color: #7c7169;
	}

	.identify input {
		border: 1px solid #d9d1c8;
		border-radius: 8px;
		padding: 0.55rem 0.7rem;
		font: inherit;
		font-size: 0.9rem;
		background: #fff;
		color: #24201d;
	}

	.identify input:focus-visible {
		outline: 2px solid #2f6f4f;
		outline-offset: 1px;
	}

	.identify-error {
		margin: 0;
		font-size: 0.83rem;
		color: #a33a2c;
	}

	.identify-actions {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
		justify-content: center;
		margin-top: 0.3rem;
	}

	.identify-actions .primary,
	.identify-actions .ghost {
		border-radius: 999px;
		padding: 0.5rem 1.1rem;
		font-size: 0.88rem;
		font-weight: 600;
		cursor: pointer;
		border: 1px solid transparent;
	}

	.identify-actions .primary {
		background: #2f6f4f;
		color: #fff;
	}

	.identify-actions .primary:disabled {
		opacity: 0.55;
		cursor: default;
	}

	.identify-actions .ghost {
		background: transparent;
		color: #7c7169;
		border-color: #d9d1c8;
	}

	/* The offer that follows a "no booking attached" refusal. */
	.offer {
		display: flex;
		justify-content: center;
		padding: 0.2rem 0 0.6rem;
	}

	.offer .primary {
		background: #2f6f4f;
		color: #fff;
		border: 0;
		border-radius: 999px;
		padding: 0.45rem 1rem;
		font-size: 0.85rem;
		font-weight: 600;
		cursor: pointer;
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

	.stay {
		color: #9a8f85;
		font-variant-numeric: tabular-nums;
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
