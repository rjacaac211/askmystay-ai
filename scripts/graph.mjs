/**
 * Render the LangGraph agent to docs/agent-graph.png and docs/agent-graph.mmd.
 *
 * Both come from the ACTUAL compiled graph in src/lib/agent.ts, so the diagram
 * cannot drift from the code. Re-run after changing nodes or edges:
 *
 *   npm run graph
 *
 * The PNG is rasterised by mermaid.ink (a third-party service). Only node and
 * edge names are sent. The .mmd source is produced locally with no network.
 */
import { register } from 'node:module';
import { writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

register(pathToFileURL(resolve(import.meta.dirname, 'lib/alias-hook.mjs')).href);

const ROOT = resolve(import.meta.dirname, '..');
const { builder } = await import(pathToFileURL(resolve(ROOT, 'src/lib/agent.ts')).href);

// No checkpointer needed: we only want the topology.
const graph = builder.compile();
const drawable = await graph.getGraphAsync();

await mkdir(resolve(ROOT, 'docs'), { recursive: true });

const mermaid = drawable.drawMermaid({ withStyles: true, curveStyle: 'linear' });
await writeFile(resolve(ROOT, 'docs/agent-graph.mmd'), mermaid, 'utf-8');
console.log('wrote docs/agent-graph.mmd\n');
console.log(mermaid);

try {
	const blob = await drawable.drawMermaidPng({ backgroundColor: 'white' });
	const buf = new Uint8Array(await blob.arrayBuffer());
	await writeFile(resolve(ROOT, 'docs/agent-graph.png'), buf);
	console.log(`wrote docs/agent-graph.png (${(buf.length / 1024).toFixed(1)} KB)`);
} catch (err) {
	console.error('\nPNG render failed (mermaid.ink unreachable?):', err.message);
	console.error('The .mmd source above was still written and renders natively on GitHub.');
	process.exit(1);
}
