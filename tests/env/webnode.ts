/* The environment of the specs whose `$effect`s must RUN, the "client"
 * project in vite.config.ts (every spec whose name ends in .client.spec.ts):
 * vitest's Node environment, with the modules compiled the client's way. The
 * default project compiles Svelte for the server, where an effect never runs,
 * so a spec could call a memo by hand but never watch the host effect that is
 * supposed to call it. Svelte's reactivity needs no DOM. */
import type { Environment } from 'vitest/runtime';

export default <Environment>{
	name: 'webnode',
	viteEnvironment: 'client',
	transformMode: 'web',
	setup() {
		return { teardown() {} };
	},
};
