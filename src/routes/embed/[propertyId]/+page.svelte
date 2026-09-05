<script lang="ts">
	import Chat from '$lib/components/Chat.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>{data.property.name} — assistant</title>
	<!-- Framed content should never be indexed on its own. -->
	<meta name="robots" content="noindex" />
</svelte:head>

<Chat
	propertyId={data.property.propertyId}
	propertyName={data.property.name}
	bookingRef={data.bookingRef}
	compact
/>

<style>
	:global(body) {
		background: #fff;
	}
</style>
