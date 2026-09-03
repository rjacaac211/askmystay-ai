import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// NOTE: the plugin comes from '@sveltejs/kit/vite', not '@sveltejs/vite-plugin-svelte'.
export default defineConfig({
	plugins: [sveltekit()]
});
