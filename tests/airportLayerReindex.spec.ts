/* The airport layer indexes every merge of the dataset (map/airportLayer.ts
 * over map/pointLayerFactory.ts). It was indexed ONCE, from the first merge:
 * a country the coverage gate brought in later (a pan, a route, a briefing's
 * forced publishers) re-merged the airports and airportByIdent answered from
 * the new merge, while the layer kept drawing the old one. The pin hide rule
 * (pinHeldByAirport) asks the new merge whether a field's symbol is drawn, so
 * an aerodrome the late overlay appended (EGSY, LERJ, EGCM, EDTE, EDUM, LOBB,
 * EBSF in the 2026-09-21 corpus, 14 NOTAMs) had its pin hidden beside no
 * symbol, and could not be clicked or snapped to either. Both map views re-run
 * their airport effect on the dataset's revision to hand the layer the new
 * merge. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Airport } from '$lib/data/airports';

// Leaflet touches `window` at import; the layer skeleton only needs a class
// with addTo / redraw and a map with hasLayer.
vi.mock('leaflet', () => ({ default: { point: (x: number, y: number) => ({ x, y }) } }));
vi.mock('$lib/map/directDrawLayer', () => ({
	ensurePane: () => {},
	DirectDrawLayer: class {
		_map: unknown = null;
		addTo(m: { layers: Set<unknown> }) {
			m.layers.add(this);
			return this;
		}
		redraw() {}
	},
}));

const mergeNow = vi.hoisted(() => ({ rows: [] as Airport[] }));
vi.mock('$lib/state/data.svelte', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/state/data.svelte')>();
	const find = (i: string) => mergeNow.rows.find((a) => a.ident === i.toUpperCase()) ?? null;
	return {
		...real,
		airportByIdent: (i: string) => find(i),
		airportLookup: (i: string) => {
			const a = find(i);
			return a ? { lat: a.lat, lon: a.lon } : null;
		},
		firIdentSet: () => new Set(['EGTT']),
	};
});
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, String(v)),
	removeItem: (k: string) => void store.delete(k),
	clear: () => store.clear(),
	key: () => null,
	length: 0,
});

const { airportHit, airportsAt, ensureAirportIndex, hideAirports, highlightAirport, showAirports, nearestAirportUngated } =
	await import('$lib/map/airportLayer');
const { pinHeldByAirport } = await import('$lib/state/notam.svelte');
const { dataState } = await import('$lib/state/data.svelte');
const { parseNotams } = await import('$lib/notam/parser');

const ap = (ident: string, lat: number, lon: number, source: Airport['source']): Airport =>
	({
		ident,
		type: 'medium_airport',
		name: ident,
		lat,
		lon,
		runways: [],
		radios: [],
		source,
	}) as unknown as Airport;

// The first merge (the baseline + the countries in view at boot), then the
// re-merge after the UK overlay arrived: EGSY is appended by the overlay.
const LFPG = ap('LFPG', 49.0097, 2.5478, 'fr');
const EGSY = ap('EGSY', 53.394, -1.388, 'uk');

const fakeMap = {
	layers: new Set<unknown>(),
	hasLayer(l: unknown) {
		return this.layers.has(l);
	},
	removeLayer() {},
	getPane: () => ({ style: {} }),
	getZoom: () => 10,
};

beforeEach(() => {
	dataState.airportsLoaded = true;
});

describe('an aerodrome a late overlay appends', () => {
	it('is drawn by the layer wherever the hide rule says its symbol stands', () => {
		// Boot: the layer is built from the first merge.
		mergeNow.rows = [LFPG];
		showAirports(fakeMap as never, mergeNow.rows);
		// The UK arrives (pan / route / forced publisher): publishAirports
		// republishes, and the map effect hands the layer the new merge.
		mergeNow.rows = [LFPG, EGSY];
		showAirports(fakeMap as never, mergeNow.rows);

		// An on-field Q-line NOTAM at EGSY (L5757/26's shape).
		const n = parseNotams(`L5757/26 NOTAMN
Q) EGTT/QMRLC/IV/NBO/A/000/999/5324N00123W005
A) EGSY B) 2609010000 C) 2610302359
E) RWY 10/28 CLSD`)[0];
		// The hide rule says the symbol stands there, so the pin is hidden...
		expect(pinHeldByAirport(n, 10)).toBe(true);
		// ...and the layer has a row there to draw, ungated too (route
		// snapping reads the same index).
		expect(nearestAirportUngated(LFPG.lat, LFPG.lon, 1000)?.airport.ident).toBe('LFPG');
		expect(nearestAirportUngated(EGSY.lat, EGSY.lon, 1000)?.airport.ident).toBe('EGSY');
	});
});

describe('the map views', () => {
	it('hand the airport layer every merge, on the dataset revision', async () => {
		const { readFileSync } = await import('node:fs');
		for (const file of ['src/lib/components/MapView.svelte', 'src/lib/components/NotamMapView.svelte']) {
			const src = readFileSync(file, 'utf8');
			const effect = src.slice(src.lastIndexOf('$effect(', src.indexOf('showAirports(map, airports)')));
			expect(effect.slice(0, effect.indexOf('showAirports(map, airports)')), file).toContain(
				'void dataState.revision.airports;',
			);
		}
	});

	it('re-index the route editor snapping on every airport and navaid merge', async () => {
		// Snapping builds the two indexes whatever the layer toggles say, once
		// anything may snap (a waypoint on the active route, or the menu open
		// for its first Add); reading only the load would have left a waypoint
		// dropped over a late country's aerodrome snapping to nothing, or to
		// the first merge's row where a later overlay replaced it.
		const { readFileSync } = await import('node:fs');
		const src = readFileSync('src/lib/components/MapView.svelte', 'utf8');
		const at = src.indexOf('ensureAirportIndex(mapState.map, a)');
		expect(at).toBeGreaterThan(0);
		const head = src.slice(src.lastIndexOf('$effect(', at), at);
		expect(head).toContain('if (!snapWanted)');
		expect(head).toContain('void dataState.revision.airports;');
		expect(head).toContain('void dataState.revision.navaids;');
		expect(src).toContain(
			'const snapWanted = $derived(activeRoute().waypoints.length > 0 || contextMenu.open);',
		);
	});
});

describe('the click and the menu with every airport group off', () => {
	// A map at zoom 10, a degree a fixed 728 px: what the pixel probes need.
	const PX = 728;
	type Pt = { x: number; y: number; add(o: { x: number; y: number }): Pt };
	const pt = (x: number, y: number): Pt => ({ x, y, add: (o) => pt(x + o.x, y + o.y) });
	const map = {
		layers: new Set<unknown>(),
		hasLayer(l: unknown) {
			return this.layers.has(l);
		},
		removeLayer(l: unknown) {
			this.layers.delete(l);
		},
		getPane: () => ({ style: {} }),
		getZoom: () => 10,
		latLngToLayerPoint: ([lat, lon]: [number, number]) => pt(lon * PX, -lat * PX),
		layerPointToLatLng: (p: { x: number; y: number }) => ({ lat: -p.y / PX, lng: p.x / PX }),
	};
	const LFPB = ap('LFPB', 48.9694, 2.4414, 'fr');

	it('leave an aerodrome the layer does not draw unclickable, the highlighted one drawn alone', () => {
		const rows = [LFPG, LFPB];
		ensureAirportIndex(map as never, rows);
		hideAirports();
		// A panel row selects CDG: the canvas attaches for that one symbol.
		highlightAirport('LFPG');
		expect(map.layers.size).toBe(1);
		expect(airportHit(map as never, LFPB.lat, LFPB.lon)).toBeNull();
		expect(airportsAt(map as never, LFPB.lat, LFPB.lon)).toEqual([]);
		expect(airportHit(map as never, LFPG.lat, LFPG.lon)).toBeNull();
		// A group on, both answer again.
		showAirports(map as never, rows);
		expect(airportHit(map as never, LFPB.lat, LFPB.lon)?.ident).toBe('LFPB');
		expect(airportsAt(map as never, LFPB.lat, LFPB.lon).map((a) => a.ident)).toEqual(['LFPB']);
		highlightAirport(null);
	});
});
