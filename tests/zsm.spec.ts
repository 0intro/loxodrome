/* The raptor zones (ZSM, data/zsm.ts, map/zsmLayer.ts): a zone the STAC's
 * file marks active holds from its record's date to its species' last day
 * of season (the DREAL Nouvelle-Aquitaine's principles of October 2025),
 * its label reads feet then metres, and the layer draws and hits only the
 * zones it was handed, the smallest under a point first, none with the
 * toggle off. Over the shipped fr-zsm.json too. Its panel groups the
 * heights as the label does, in both languages (docs/i18n.md: an aviation
 * value is invariant). */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { feetOf, loadZsm, seasonEnd, zsmActiveIn, zsmLabel, zsmRules, type Zsm } from '$lib/data/zsm';
import { ringAreaM2, ringBbox } from '$lib/notam/geometry';

vi.mock('leaflet', () => {
	const group = () => {
		const g = { addTo: () => g, remove: () => g, clearLayers: () => g };
		return g;
	};
	const L = {
		// directDrawLayer subclasses L.Layer at module scope.
		Layer: class {},
		layerGroup: group,
		polygon: () => ({ addTo: () => undefined }),
		marker: () => ({ addTo: () => undefined }),
		divIcon: () => ({}),
		latLng: (lat: number, lng: number) => ({ lat, lng }),
	};
	return { default: L, ...L };
});

const { setZsmVisible, setZsmZones, zsmAreaAt } = await import('$lib/map/zsmLayer');

function square(id: string, lat: number, lon: number, size: number, over: Partial<Zsm> = {}): Zsm {
	const h = size / 2;
	const ring: [number, number][] = [
		[lat - h, lon - h],
		[lat - h, lon + h],
		[lat + h, lon + h],
		[lat + h, lon - h],
		[lat - h, lon - h],
	];
	return { id, name: id, species: 'Gypaète barbu', taxon: '2852', active: true, topM: 2110, overflyM: 3110, modified: '2026-10-31', ring, bbox: ringBbox(ring), areaM2: ringAreaM2(ring), ...over };
}

const fakeMap = () =>
	({
		getPane: () => ({ style: {} }),
		createPane: () => ({ style: {} }),
		on: () => undefined,
		off: () => undefined,
		hasLayer: () => false,
		getZoom: () => 9,
		latLngToLayerPoint: () => ({ x: 0, y: 0 }),
	}) as unknown as import('leaflet').Map;

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

describe('a zone of major sensitivity', () => {
	it('holds from its record over the new year to its season’s end', () => {
		expect(seasonEnd('Gypaète barbu', '2026-10-31')).toBe('2027-08-31');
		expect(seasonEnd('Gypaète barbu', '2027-03-02')).toBe('2027-08-31');
		expect(seasonEnd('Vautour percnoptère', '2027-03-01')).toBe('2027-09-15');
		expect(seasonEnd('Unknown bird', '2026-10-31')).toBeUndefined();
		const z = square('a', 44.9, 6.7, 0.1);
		expect(zsmRules(z)).toEqual([{ mode: 'firm', date: '2026-10-31', dateTo: '2027-08-31' }]);
		expect(zsmRules({ ...z, active: false })).toEqual([]);
		expect(zsmRules({ ...z, species: 'Unknown bird' })).toEqual([{ mode: 'firm', date: '2026-10-31' }]);
		expect(zsmActiveIn(z, day('2026-11-23'), day('2026-11-23'))).toBe(true);
		expect(zsmActiveIn(z, day('2027-08-31') + 3_600_000, day('2027-08-31') + 3_600_000)).toBe(true);
		expect(zsmActiveIn(z, day('2027-09-01'), day('2027-09-02'))).toBe(false);
		expect(zsmActiveIn(z, day('2026-10-01'), day('2026-10-30'))).toBe(false);
		expect(zsmActiveIn({ ...z, active: false }, day('2026-11-23'), day('2026-11-23'))).toBe(false);
	});

	it('labels its overflight height in feet, then metres, the feet never below the height', () => {
		// 3 110 m is 10 203.4 ft, and 3 048 m 10 000 ft exactly.
		expect(feetOf(3110)).toBe(10210);
		expect(feetOf(3048)).toBe(10000);
		expect(zsmLabel(3110)).toBe('10 210 ft (3 110 m)');
		expect(zsmLabel(950)).toBe('3 120 ft (950 m)');
		const doc = JSON.parse(readFileSync('public/data/fr-zsm.json', 'utf8')) as { fields: string[]; rows: unknown[][] };
		const col = doc.fields.indexOf('overflyM');
		for (const m of doc.rows.map((r) => Number(r[col]))) {
			expect(feetOf(m) * 0.3048).toBeGreaterThanOrEqual(m - 1e-9);
			expect(feetOf(m) * 0.3048).toBeLessThan(m + 3.048);
		}
	});
});

describe('the layer', () => {
	const big = square('big', 44.9, 6.7, 0.2);
	const small = square('small', 44.9, 6.7, 0.05);
	const far = square('far', 42.9, 0.3, 0.05);

	it('hits the smallest zone it drew under a point, none with the toggle off', () => {
		setZsmZones(fakeMap(), [big, small, far]);
		setZsmVisible(false);
		expect(zsmAreaAt(44.9, 6.7)).toBeNull();
		setZsmVisible(true);
		expect(zsmAreaAt(44.9, 6.7)?.zone.id).toBe('small');
		expect(zsmAreaAt(44.97, 6.77)?.zone.id).toBe('big');
		expect(zsmAreaAt(45.5, 6.7)).toBeNull();
		setZsmZones(fakeMap(), [far]);
		expect(zsmAreaAt(44.9, 6.7)).toBeNull();
	});
});

describe('the shipped zones', () => {
	it('read whole, each with a closed ring and a height over its highest point', async () => {
		const fetchMock = vi.fn(() => Promise.resolve(new Response(readFileSync('public/data/fr-zsm.json', 'utf8'), { status: 200, headers: { 'content-type': 'application/json' } })));
		vi.stubGlobal('fetch', fetchMock);
		const zones = await loadZsm();
		vi.unstubAllGlobals();
		expect(zones.length).toBeGreaterThan(100);
		expect(new Set(zones.map((z) => z.id)).size).toBe(zones.length);
		for (const z of zones) {
			expect(z.ring.length, z.id).toBeGreaterThanOrEqual(4);
			expect(z.overflyM - z.topM, z.id).toBe(1000);
			expect(z.modified, z.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		}
	});
});

describe('the panel', () => {
	it('groups the heights as the label does, in both languages', async () => {
		const { render } = await import('svelte/server');
		const { default: ZsmDetail } = await import('$lib/components/detail/ZsmDetail.svelte');
		const { i18n } = await import('$lib/state/i18n.svelte');
		const zone = square('Le Rompeau', 44.82, 6.234, 0.01);
		try {
			for (const locale of ['en', 'fr'] as const) {
				i18n.locale = locale;
				const { body } = render(ZsmDetail, { props: { zone } });
				expect(body, locale).toContain('10\u202f210 ft (3\u202f110 m)');
				expect(body, locale).toContain('2\u202f110 m');
			}
		} finally {
			i18n.locale = 'en';
		}
	});
});

