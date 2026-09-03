/**
 * Node resolver hook that stands in for Vite's module aliases so scripts can
 * import the real src/lib/agent.ts outside of Vite.
 *
 * `$env/dynamic/private` is a Vite virtual module and `$lib/*` is a SvelteKit
 * alias; neither resolves under plain Node. Mapping them here means the graph
 * we draw is the actual compiled graph, not a hand-maintained copy that can
 * silently drift from the code.
 */
import { pathToFileURL } from 'node:url';
import { resolve as resolvePath } from 'node:path';

const ROOT = resolvePath(import.meta.dirname, '../..');

export function resolve(specifier, context, next) {
	if (specifier === '$env/dynamic/private') {
		return { url: pathToFileURL(resolvePath(import.meta.dirname, 'env-stub.mjs')).href, shortCircuit: true };
	}
	if (specifier.startsWith('$lib/')) {
		const rest = specifier.slice('$lib/'.length).replace(/\.js$/, '');
		return { url: pathToFileURL(resolvePath(ROOT, 'src/lib', `${rest}.ts`)).href, shortCircuit: true };
	}
	return next(specifier, context);
}
