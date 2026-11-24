/* The NOTAM Viewer's Restore default settings (src/notam/defaultSettings.ts):
 * the preferences THIS app offers, back to their defaults, and nothing else.
 * On loxodrome.fr/notam the storage is the flight app's too, so every key
 * outside the viewer's scope must survive, the flight app's layers document
 * byte for byte (the viewer pins the layers in memory and never writes
 * them), and the module must not pull the flight app's recorder, sync or
 * route persistence into the viewer's bundle. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { memoryStorage, type MemoryStorage } from './helpers/storage';
import { KEEP_SEEDS, PREF_SEEDS } from './helpers/prefSeeds';
import { staticClosure } from './helpers/staticClosure';

/** The keys of what the viewer offers: its languages, theme and live
 *  weather, the profile scope and rows, the night dimming, the six marker
 *  toggles, the NOTAM filters it mounts, its briefing source, its one side
 *  panel's width and its airspace profile's placement and dock size. */
const VIEWER_SCOPE = [
	'loxodrome:locale',
	'loxodrome:theme',
	'loxodrome:supaip-lang',
	'loxodrome:sofia-lang',
	'loxodrome:aip-remark-lang',
	'loxodrome:live-weather',
	'loxodrome:profile-all-airspaces',
	'loxodrome:notam-type-icons',
	'loxodrome:notam-qline-markers',
	'loxodrome:notam-qline-radius',
	'loxodrome:hide-airport-notam-markers',
	'loxodrome:affected-airspaces',
	'loxodrome:show-in-airspaces',
	'loxodrome:night-dim',
	'loxodrome:profile-class-a',
	'loxodrome:profile-class-b',
	'loxodrome:profile-class-c',
	'loxodrome:profile-class-d',
	'loxodrome:profile-class-e',
	'loxodrome:profile-zone-restricted',
	'loxodrome:profile-zone-military',
	'loxodrome:profile-zone-trafficmgmt',
	'loxodrome:profile-zone-other',
	'loxodrome:profile-activity',
	'loxodrome:profile-fir',
	'loxodrome:profile-siv',
	'loxodrome:altitude-band',
	'loxodrome:notam-kind',
	'loxodrome:notam-horizon',
	'loxodrome:notam-rules',
	'loxodrome:notam-source',
	'loxodrome:detail-width',
	'loxodrome:surface:airspaceProfile:placement',
	'loxodrome:surface:airspaceProfile:size-bottom',
	'loxodrome:surface:airspaceProfile:size-right',
];

let ls: MemoryStorage;

beforeEach(() => {
	vi.resetModules();
	ls = memoryStorage({ ...PREF_SEEDS, ...KEEP_SEEDS });
	vi.stubGlobal('localStorage', ls);
	vi.stubGlobal('navigator', { languages: ['en-GB'], language: 'en-GB' });
	vi.stubGlobal(
		'fetch',
		vi.fn(() => Promise.resolve(new Response('{}', { status: 404 }))),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("the viewer's Restore default settings", () => {
	it('resets what the viewer offers and leaves the flight app its own', { timeout: 30_000 }, async () => {
		(await import('$lib/state/appIdentity')).markNotamViewer();
		const { layers } = await import('$lib/state/layers.svelte');
		expect(layers.baseLayer).toBe('ign');
		const { restoreViewerDefaultSettings } = await import('../src/notam/defaultSettings');
		// Taken once the modules have loaded: the legacy key is erased at
		// load by the modules themselves, not by the restore.
		const before = ls.dump();
		restoreViewerDefaultSettings();
		const after = ls.dump();
		for (const key of VIEWER_SCOPE) {
			expect(after[key], key).toBeUndefined();
		}
		// Everything else stands, byte for byte, the flight app's layers
		// document and its route corridor switch among it.
		const rest = Object.fromEntries(
			Object.entries(before).filter(([k]) => !VIEWER_SCOPE.includes(k)),
		);
		expect(after).toEqual(rest);
		expect(after['loxodrome:layers']).toBe(PREF_SEEDS['loxodrome:layers']);
		expect(after['loxodrome:notams-on-route']).toBe('on');
		// The layers are back in memory, never written.
		expect(layers.baseLayer).toBe('osm');
		expect(layers.chartStack).toEqual([]);
		expect(layers.airspace.controlled).toBe(false);
	});

	it('takes the layers out of the address the next boot reads', async () => {
		(await import('$lib/state/appIdentity')).markNotamViewer();
		const replaceState = vi.fn();
		vi.stubGlobal('location', {
			pathname: '/notam/',
			search: '',
			hash: '#map=8/48.50000/2.50000&layer=ign',
		});
		vi.stubGlobal('history', { state: null, replaceState });
		(await import('../src/notam/defaultSettings')).restoreViewerDefaultSettings();
		expect(replaceState).toHaveBeenCalledOnce();
		expect(replaceState.mock.calls[0]?.[2]).toBe('/notam/#map=8/48.50000/2.50000');
	});

	it('offers exactly the display fields its two panels read', async () => {
		const { VIEWER_DISPLAY_PREFS } = await import('../src/notam/defaultSettings');
		const read = new Set<string>();
		for (const file of ['src/notam/SettingsPopover.svelte', 'src/notam/LayersPopover.svelte']) {
			// The state object's fields, not the catalog's (t.display.*) nor
			// the module's path (display.svelte).
			for (const [, field] of readFileSync(file, 'utf8').matchAll(/(?<![.\w/])display\.(\w+)/g)) {
				read.add(field ?? '');
			}
		}
		expect([...VIEWER_DISPLAY_PREFS].sort()).toEqual([...read].sort());
	});

	it('pulls none of the flight app into the viewer', () => {
		const closure = staticClosure('src/notam/defaultSettings.ts');
		for (const heavy of [
			'src/lib/state/reset.ts',
			'src/lib/state/defaultSettings.ts',
			'src/lib/state/radar.svelte.ts',
			'src/lib/state/airspaceAlert.svelte.ts',
			'src/lib/state/windAloft.svelte.ts',
			'src/lib/state/sync.svelte.ts',
			'src/lib/state/routePersist.ts',
			'src/lib/state/flightLibrary.svelte.ts',
		]) {
			expect(closure.has(heavy), heavy).toBe(false);
		}
	});
});
