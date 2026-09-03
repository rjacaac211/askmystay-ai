// Stands in for SvelteKit's $env/dynamic/private, which under adapter-node is
// exactly process.env. Drawing the graph touches no secrets, but the module
// must resolve for the import to succeed.
export const env = process.env;
