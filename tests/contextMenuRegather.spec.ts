/* The map menu over a country whose datasets are still loading. Its
 * Airspaces and SUP AIP sections read the datasets at its point, and
 * MapView gathered the open menu again only on the datasets' first load: a
 * country the last pan reached landed after a right-click there and the open
 * menu, its Altitude profile count included, never showed its volumes. Every
 * republication of either dataset gathers the open menu again now, at its
 * own point and place (state/contextMenu.svelte.ts regatherContextMenu, run
 * from a MapView effect pinned here by its whole normalised body, as
 * tests/radarCaution.spec.ts pins the dialog's: a client spec has no DOM to
 * mount the map in). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ContextFeatures } from '$lib/map/interactions';
import {
	closeContextMenu,
	contextMenu,
	openContextMenu,
	regatherContextMenu,
} from '$lib/state/contextMenu.svelte';

/** A gather answering `airspaces` keys, as contextFeaturesAt would. */
function features(keys: string[]): ContextFeatures {
	return {
		notams: [],
		stations: [],
		radar: null,
		airports: [],
		navaids: [],
		airspaces: keys.map((key) => ({ key, id: key })),
		obstacles: [],
		supaips: [],
		zsm: [],
		sigmets: [],
		charts: [],
		waypoints: [],
		leg: null,
	} as unknown as ContextFeatures;
}

afterEach(() => {
	closeContextMenu();
});

describe('the open menu gathered again', () => {
	it('takes the rows a dataset published at its point, where it stands', () => {
		openContextMenu(features(['LFMM']), 41.39, 2.17, 600, 400);
		const asked: [number, number][] = [];
		regatherContextMenu((lat, lng) => {
			asked.push([lat, lng]);
			return features(['LFMM', 'LEBL-TMA']);
		});
		expect(asked).toEqual([[41.39, 2.17]]);
		expect(contextMenu.open).toBe(true);
		expect(contextMenu.airspaces.map((a) => a.key)).toEqual(['LFMM', 'LEBL-TMA']);
		expect([contextMenu.lat, contextMenu.lng, contextMenu.x, contextMenu.y]).toEqual([41.39, 2.17, 600, 400]);
	});

	it('gathers nothing while the menu is shut', () => {
		let asked = 0;
		regatherContextMenu(() => {
			asked++;
			return features([]);
		});
		expect(asked).toBe(0);
		expect(contextMenu.open).toBe(false);
	});

	it('runs on every republication of the airspaces, the SUP AIP or the raptor zones', () => {
		const src = readFileSync(join(process.cwd(), 'src/lib/components/MapView.svelte'), 'utf8');
		const at = src.indexOf('regatherContextMenu(');
		expect(at).toBeGreaterThan(0);
		const open = src.lastIndexOf('$effect(() => {', at);
		const close = src.indexOf('\n\t});', at);
		expect(src.slice(open, close + 5).replace(/\s+/g, ' ')).toBe(
			'$effect(() => { void dataState.revision.airspaces; void dataState.revision.supaip; void zsmState.loaded; untrack(() => { if (map) { const m = map; regatherContextMenu((lat, lng) => contextFeaturesAt(m, lat, lng)); } }); });',
		);
	});
});
