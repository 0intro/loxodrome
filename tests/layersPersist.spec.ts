/* The stored layer choices are SPARSE (state/layers.svelte.ts,
 * docs/preferences.md): the doc holds only what differs from the defaults,
 * leaf by leaf inside a record. Before, one toggle wrote all 49 values, so a
 * stored doc could not tell "turned this off" from "it was off by default",
 * and a later change of a default never reached anyone who had touched a
 * single layer. The module seeds itself at evaluation, hence the re-import
 * per case (the layersViewerReset.spec idiom). */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from './helpers/storage';

const KEY = 'loxodrome:layers';

function stored(): unknown {
	const raw = localStorage.getItem(KEY);
	return raw === null ? null : JSON.parse(raw);
}

beforeEach(() => {
	vi.resetModules();
	vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('the stored layer choices', () => {
	it('hold nothing at the defaults', async () => {
		const { persistLayers } = await import('$lib/state/layers.svelte');
		persistLayers();
		expect(stored()).toBeNull();
	});

	it('hold one field when one field differs', async () => {
		const { layers, persistLayers } = await import('$lib/state/layers.svelte');
		layers.baseLayer = 'ign';
		persistLayers();
		expect(stored()).toEqual({ v: 1, baseLayer: 'ign' });
	});

	it("hold a record's differing leaves only", async () => {
		const { layers, persistLayers, toggleChartLayer } = await import('$lib/state/layers.svelte');
		layers.airspace.controlled = true;
		layers.publisher.uk = false;
		toggleChartLayer('fr500');
		persistLayers();
		expect(stored()).toEqual({
			v: 1,
			airspace: { controlled: true },
			publisher: { uk: false },
			chartStack: ['fr500'],
		});
		// Back at every default, the key goes.
		layers.airspace.controlled = false;
		layers.publisher.uk = true;
		toggleChartLayer('fr500');
		persistLayers();
		expect(stored()).toBeNull();
	});

	it('read a sparse doc back over the defaults', async () => {
		localStorage.setItem(
			KEY,
			JSON.stringify({ v: 1, baseLayer: 'topo', navaids: { ils: true }, chartStack: ['fr250'] }),
		);
		const { layers } = await import('$lib/state/layers.svelte');
		expect(layers.baseLayer).toBe('topo');
		expect(layers.navaids).toEqual({ navaids: false, ils: true, waypoints: false, reporting: false });
		expect(layers.chartStack).toEqual(['fr250']);
		expect(layers.airspaceLabels).toBe(true);
	});

	it('keep Plan IGN as the chosen base map', async () => {
		// A base layer the validator does not know is dropped on read; the id
		// set is compiler-checked against the union, this proves the round trip.
		const first = await import('$lib/state/layers.svelte');
		first.layers.baseLayer = 'planign';
		first.persistLayers();
		expect(stored()).toEqual({ v: 1, baseLayer: 'planign' });
		vi.resetModules();
		const { layers } = await import('$lib/state/layers.svelte');
		expect(layers.baseLayer).toBe('planign');
	});

	it("compact an older build's whole doc to what differs, reading it the same", async () => {
		// What a build before the sparse writer stored after one change: every
		// default spelled out beside the one choice.
		const fresh = await import('$lib/state/layers.svelte');
		const whole: Record<string, unknown> = {
			v: 1,
			...(JSON.parse(JSON.stringify(fresh.layers)) as Record<string, unknown>),
			baseLayer: 'google',
		};
		delete whole.chartSource;
		vi.resetModules();
		localStorage.setItem(KEY, JSON.stringify(whole));
		const { layers, persistLayers } = await import('$lib/state/layers.svelte');
		expect(layers.baseLayer).toBe('google');
		persistLayers();
		expect(stored()).toEqual({ v: 1, baseLayer: 'google' });
	});
});

/* A #map= link carries a base map and a chart stack: the SENDER's. The map
 * shows them, but storage keeps the pilot's own until the pilot changes one
 * of them on screen. Stored as they arrived, a shared link replaced the
 * pilot's charts, and a bare #map= (the OSM default and an empty stack)
 * erased the choice outright, so the next visit without a hash opened on
 * OSM with no charts. */
describe("a link's layers", () => {
	const OWN = { v: 1, baseLayer: 'topo', chartStack: ['fr500', 'fr250'] };

	async function withOwn() {
		localStorage.setItem(KEY, JSON.stringify(OWN));
		return import('$lib/state/layers.svelte');
	}

	it('show on screen and leave the stored choice as it was', async () => {
		const l = await withOwn();
		l.applyLinkLayers('google', ['frvv500']);
		l.persistLayers();
		expect(l.layers.baseLayer).toBe('google');
		expect(l.layers.chartStack).toEqual(['frvv500']);
		expect(stored()).toEqual(OWN);
	});

	it('never erase it, a bare link included', async () => {
		const l = await withOwn();
		l.applyLinkLayers('osm', []);
		l.persistLayers();
		expect(stored()).toEqual(OWN);
		// Another choice made under the link stores only that choice.
		l.layers.supaip = true;
		l.persistLayers();
		expect(stored()).toEqual({ ...OWN, supaip: true });
	});

	it("become the pilot's once the pilot changes them on screen", async () => {
		const l = await withOwn();
		l.applyLinkLayers('google', ['frvv500']);
		l.layers.baseLayer = 'ign';
		l.persistLayers();
		// The base map picked is the pilot's; the stack still shows the link's.
		expect(stored()).toEqual({ ...OWN, baseLayer: 'ign' });
		l.toggleChartLayer('fr250');
		l.persistLayers();
		expect(stored()).toEqual({ v: 1, baseLayer: 'ign', chartStack: ['frvv500', 'fr250'] });
	});

	it('keep a pick made before a link as the pilot\'s own under it', async () => {
		const l = await withOwn();
		l.layers.baseLayer = 'ign';
		l.persistLayers();
		expect(stored()).toEqual({ ...OWN, baseLayer: 'ign' });
		l.applyLinkLayers('google', ['frvv500']);
		l.persistLayers();
		expect(stored()).toEqual({ ...OWN, baseLayer: 'ign' });
	});

	it('store a pick made after the defaults came back, whatever the link had said', async () => {
		const l = await withOwn();
		l.applyLinkLayers('google', ['frvv500']);
		// Restore without a write between (the NOTAM Viewer's own pin, or a
		// write the effect had not flushed yet): the link is forgotten with
		// the choices, so a later pick of the link's own value is a pick.
		l.resetLayerChoices();
		l.layers.baseLayer = 'google';
		l.persistLayers();
		expect(stored()).toEqual({ v: 1, baseLayer: 'google' });
	});

	it('follow a later link over the first, and go with the defaults', async () => {
		const l = await withOwn();
		l.applyLinkLayers('google', []);
		l.persistLayers();
		l.applyLinkLayers('bing', ['us500']);
		l.persistLayers();
		expect(stored()).toEqual(OWN);
		l.resetLayerChoices();
		l.persistLayers();
		expect(stored()).toBeNull();
		expect(l.layers.baseLayer).toBe('osm');
	});
});
