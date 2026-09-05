<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const l = $derived(data.property.listing);

	function money(amount: number, currency: string): string {
		try {
			return new Intl.NumberFormat('en-US', {
				style: 'currency',
				currency,
				maximumFractionDigits: 0
			}).format(amount);
		} catch {
			return `${amount} ${currency}`;
		}
	}
</script>

<svelte:head>
	<title>{data.property.name} — AskMyStay</title>
	<meta name="description" content={l.tagline} />

	<!--
		The assistant, added exactly the way a host would add it to their own
		guidebook or microsite: one script tag with data attributes. Nothing on this
		page imports the chat component — it arrives in an iframe from /embed, so
		this route is a genuine test of the embed path rather than a shortcut around
		it. data-booking is set only when the guest arrived on a host's link; with
		no booking the widget asks who is holding it.
	-->
	<script
		src="/widget.js"
		data-property={data.property.propertyId}
		data-booking={data.bookingRef || undefined}
		data-label="Ask about this place"
		async
	></script>
</svelte:head>

<header class="masthead">
	<div class="wrap">
		<a class="back" href="/">← All places</a>
		<p class="location">{l.location}</p>
		<h1>{data.property.name}</h1>
		<p class="tagline">{l.tagline}</p>
	</div>
</header>

<main class="wrap">
	<div class="facts">
		<div><strong>{l.guests}</strong> guests</div>
		<div><strong>{l.bedrooms}</strong> bedroom{l.bedrooms === 1 ? '' : 's'}</div>
		<div><strong>{l.beds}</strong> bed{l.beds === 1 ? '' : 's'}</div>
		<div><strong>{l.baths}</strong> bath{l.baths === 1 ? '' : 's'}</div>
		<div class="rate"><strong>{money(l.nightlyRate, l.currency)}</strong> per night</div>
	</div>

	{#if l.description}
		<section>
			<h2>About this place</h2>
			<p>{l.description}</p>
		</section>
	{/if}

	<!--
		Deliberately short. Everything a guest might otherwise scroll for — amenities,
		house rules, wifi, parking, the heating — is answered by the assistant, and
		duplicating it here would make the assistant redundant on its own page. The
		full listing data is still indexed; it is just not printed.
	-->
	{#if l.highlights.length > 0}
		<section>
			<h2>Good to know</h2>
			<ul class="ticks">
				{#each l.highlights.slice(0, 3) as item (item)}
					<li>{item}</li>
				{/each}
			</ul>
		</section>
	{/if}

	<p class="nudge">
		Everything else — amenities, house rules, parking, the heating, trash day, where to eat — ask
		the assistant in the corner. It answers from this property's guidebook, and from your booking
		once you attach one.
	</p>
</main>

<style>
	:global(body) {
		margin: 0;
		background: #f5f3f0;
		color: #24201d;
		font-family:
			ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
		line-height: 1.6;
	}

	.wrap {
		max-width: 44rem;
		margin: 0 auto;
		padding: 0 1.25rem;
	}

	.masthead {
		background: #1e3a2f;
		color: #f4f1ec;
		padding: 1.75rem 0 3rem;
		margin-bottom: 2rem;
	}

	.back {
		display: inline-block;
		margin-bottom: 1.4rem;
		font-size: 0.85rem;
		color: #f4f1ec;
		opacity: 0.75;
		text-decoration: none;
	}

	.back:hover {
		opacity: 1;
	}

	.location {
		margin: 0 0 0.25rem;
		font-size: 0.72rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		opacity: 0.7;
	}

	h1 {
		margin: 0 0 0.35rem;
		font-size: 1.9rem;
	}

	.tagline {
		margin: 0;
		opacity: 0.85;
	}

	.facts {
		display: flex;
		flex-wrap: wrap;
		gap: 1.4rem;
		padding: 1rem 1.2rem;
		background: #fff;
		border: 1px solid #e6dfd7;
		border-radius: 10px;
		font-size: 0.88rem;
		color: #6b675f;
	}

	.facts strong {
		color: #24201d;
	}

	.facts .rate {
		margin-left: auto;
	}

	section {
		margin: 2rem 0;
	}

	h2 {
		margin: 0 0 0.5rem;
		font-size: 1.05rem;
	}

	section p {
		margin: 0;
		color: #4a453f;
	}

	.ticks {
		margin: 0;
		padding: 0;
		list-style: none;
		display: grid;
		gap: 0.35rem;
		grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
		font-size: 0.92rem;
		color: #4a453f;
	}

	.ticks li::before {
		content: '·';
		color: #2f6f4f;
		font-weight: 700;
		margin-right: 0.5rem;
	}

	.nudge {
		margin: 2.5rem 0 6rem;
		padding: 0.9rem 1.1rem;
		background: #eef3ef;
		border-left: 3px solid #2f6f4f;
		border-radius: 0 6px 6px 0;
		font-size: 0.9rem;
		color: #4a453f;
	}
</style>
