<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

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
	<title>AskMyStay — places to stay</title>
	<meta name="description" content="Short-term rentals with a guidebook-grounded assistant." />
</svelte:head>

<header class="masthead">
	<div class="wrap">
		<p class="brand">AskMyStay</p>
		<h1>Places to stay</h1>
		<p class="lede">
			Every listing has an assistant grounded in that property's own guidebook. Attach your booking
			and it can answer about your stay too.
		</p>
	</div>
</header>

<main class="wrap">
	{#if data.properties.length === 0}
		<p class="empty">No properties are seeded yet. Run <code>npm run seed</code>.</p>
	{:else}
		<ul class="catalogue">
			{#each data.properties as property (property.propertyId)}
				{@const l = property.listing}
				<li>
					<a class="card" href="/p/{property.propertyId}">
						<p class="location">{l.location}</p>
						<h2>{property.name}</h2>
						<p class="tagline">{l.tagline}</p>
						<p class="facts">
							{l.guests} guests · {l.bedrooms} bedroom{l.bedrooms === 1 ? '' : 's'} · {l.beds} bed{l.beds ===
							1
								? ''
								: 's'} · {l.baths} bath{l.baths === 1 ? '' : 's'}
						</p>
						<p class="rate"><strong>{money(l.nightlyRate, l.currency)}</strong> night</p>
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</main>

<style>
	:global(body) {
		margin: 0;
		background: #f5f3f0;
		color: #24201d;
		font-family:
			ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
		line-height: 1.55;
	}

	.wrap {
		max-width: 54rem;
		margin: 0 auto;
		padding: 0 1.25rem;
	}

	.masthead {
		background: #1e3a2f;
		color: #f4f1ec;
		padding: 2.5rem 0 3rem;
		margin-bottom: 2.5rem;
	}

	.brand {
		margin: 0 0 0.8rem;
		font-size: 0.72rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		opacity: 0.72;
	}

	h1 {
		margin: 0 0 0.4rem;
		font-size: 1.9rem;
	}

	.lede {
		margin: 0;
		max-width: 34rem;
		opacity: 0.85;
		font-size: 0.95rem;
	}

	.catalogue {
		list-style: none;
		margin: 0 0 4rem;
		padding: 0;
		display: grid;
		gap: 1rem;
		grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
	}

	.card {
		display: block;
		height: 100%;
		box-sizing: border-box;
		padding: 1.2rem 1.3rem 1.3rem;
		background: #fff;
		border: 1px solid #e6dfd7;
		border-radius: 12px;
		text-decoration: none;
		color: inherit;
		transition:
			border-color 0.15s,
			transform 0.15s;
	}

	.card:hover {
		border-color: #2f6f4f;
		transform: translateY(-2px);
	}

	.location {
		margin: 0 0 0.25rem;
		font-size: 0.75rem;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: #a89c92;
	}

	h2 {
		margin: 0 0 0.3rem;
		font-size: 1.1rem;
	}

	.tagline {
		margin: 0 0 0.7rem;
		font-size: 0.9rem;
		color: #6b675f;
	}

	.facts {
		margin: 0 0 0.6rem;
		font-size: 0.83rem;
		color: #7c7169;
	}

	.rate {
		margin: 0;
		font-size: 0.9rem;
		color: #24201d;
	}

	.empty {
		margin: 0 0 4rem;
		color: #7c7169;
	}

	code {
		background: #e9e3dc;
		border-radius: 3px;
		padding: 0.05rem 0.3rem;
	}
</style>
