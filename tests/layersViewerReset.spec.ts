/* The NOTAM Viewer starts from the default layers, whatever the flight app
 * stored (state/layers.svelte.ts resetLayerChoices, called by
 * src/notam/main.ts before it mounts). The layer module seeds itself from
 * 'loxodrome:layers' at init, and on loxodrome.fr/notam that is the flight
 * app's document: unticking a country next door took it off the viewer's map
 * with no control there to bring it back. The module is re-imported per case,
 * since the seed runs at evaluation (the pilotStore.spec idiom). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const LAYERS_KEY = 'loxodrome:layers';

function workingStorage(): Storage {
	const store = new Map<string, string>();
	return {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	} as unknown as Storage;
}

beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal('localStorage', workingStorage());
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('the viewer layer reset', () => {
	it('drops what the flight app stored, back to the defaults', async () => {
		const fresh = await import('$lib/state/layers.svelte');
		const defaults = JSON.parse(JSON.stringify(fresh.layers)) as Record<string, unknown>;
		vi.resetModules();
		localStorage.setItem(
			LAYERS_KEY,
			JSON.stringify({ v: 1, baseLayer: 'google', publisher: { uk: false }, chartStack: ['fr500'] }),
		);
		const { layers, resetLayerChoices } = await import('$lib/state/layers.svelte');
		// The precondition: the seed really did inherit the flight app's doc.
		expect(layers.baseLayer).toBe('google');
		expect(layers.publisher.uk).toBe(false);
		expect(layers.chartStack).toEqual(['fr500']);
		resetLayerChoices();
		expect(JSON.parse(JSON.stringify(layers))).toEqual(defaults);
		// And it READS the stored doc only to seed, never writes it back: the
		// flight app's choices stay where the flight app put them.
		expect(JSON.parse(localStorage.getItem(LAYERS_KEY) ?? 'null')).toMatchObject({ baseLayer: 'google' });
	});

	it('is what the viewer does before it mounts', () => {
		const main = readFileSync('src/notam/main.ts', 'utf8');
		const reset = main.indexOf('resetLayerChoices();');
		expect(reset).toBeGreaterThan(0);
		expect(reset).toBeLessThan(main.indexOf('mount(App'));
	});
});
