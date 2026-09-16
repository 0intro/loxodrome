import { describe, expect, it } from 'vitest';
import { i18n } from '$lib/state/i18n.svelte';
import { metarTiles, stationTipLines, type MapStation } from '$lib/state/metarStations.svelte';
import type { AwcMetar } from '$lib/weather/awc';

describe('metarTiles', () => {
	it('tiles a country view into 4-degree integer-aligned cells', () => {
		const tiles = metarTiles({ west: -5, south: 42, east: 8, north: 51 })!;
		expect(tiles).toHaveLength(12); // 4 columns x 3 rows
		expect(tiles.map((t) => t.key)).toContain('48,0');
		for (const t of tiles) {
			expect(t.bbox.maxLon - t.bbox.minLon).toBeLessThanOrEqual(4);
			expect(t.bbox.maxLat - t.bbox.minLat).toBeLessThanOrEqual(4);
			// abs() because -8 % 4 is -0, which Object.is-based toBe rejects.
			expect(Math.abs(t.bbox.minLon % 4)).toBe(0);
			expect(Math.abs(t.bbox.minLat % 4)).toBe(0);
		}
	});

	it('refuses views spanning more than the tile budget', () => {
		expect(metarTiles({ west: -30, south: 20, east: 30, north: 70 })).toBeNull();
	});

	it('splits an antimeridian-crossing view into proxy-legal spans', () => {
		const tiles = metarTiles({ west: 175, south: 0, east: -170, north: 3 })!;
		expect(tiles).toHaveLength(5);
		for (const t of tiles) {
			expect(t.bbox.minLon).toBeLessThan(t.bbox.maxLon);
			expect(t.bbox.minLon).toBeGreaterThanOrEqual(-180);
			expect(t.bbox.maxLon).toBeLessThanOrEqual(180);
		}
	});

	it('clamps latitudes to world bounds', () => {
		const tiles = metarTiles({ west: 0, south: 87, east: 3, north: 92 })!;
		expect(tiles.every((t) => t.bbox.maxLat <= 90)).toBe(true);
	});
});

describe('stationTipLines', () => {
	it('reads ident, name, category, age and the decoded chips', () => {
		const metar = {
			icaoId: 'LFPO',
			name: 'Paris-Orly, ID, FR',
			obsTime: 0,
			rawOb: '',
			lat: 48.72,
			lon: 2.38,
			wdir: 240,
			wspd: 8,
			fltCat: 'VFR',
			visib: '6+',
			clouds: [{ cover: 'BKN', base: 4000 }],
			altim: 1017.2,
		} as AwcMetar;
		const st: MapStation = { metar, cat: 'VFR', ageMin: 12, freshness: 'ok' };
		const lines = stationTipLines(st);
		expect(lines[0]).toBe('LFPO Paris-Orly');
		expect(lines[1]).toBe('VFR, 12 min ago');
		expect(lines).toContainEqual(expect.stringContaining('Wind 240° 8 kt'));
		expect(lines.some((l) => l.startsWith('Visibility'))).toBe(true);
		expect(lines).toContainEqual(expect.stringContaining('BKN 4000 ft'));
		expect(lines).toContain('QNH 1017');
	});

	it('degrades without category, wind or QNH', () => {
		const metar = { icaoId: 'EHSC', obsTime: 0, rawOb: '', lat: 53, lon: 3 } as AwcMetar;
		const lines = stationTipLines({ metar, cat: null, ageMin: 30, freshness: 'ok' });
		expect(lines[0]).toBe('EHSC');
		expect(lines[1]).toBe('No category, 30 min ago');
		expect(lines).toHaveLength(2);
	});

	it('renders the badge in French when the locale flips', () => {
		const metar = { icaoId: 'EHSC', obsTime: 0, rawOb: '', lat: 53, lon: 3 } as AwcMetar;
		i18n.locale = 'fr';
		try {
			const lines = stationTipLines({ metar, cat: null, ageMin: 30, freshness: 'ok' });
			expect(lines[1]).toBe('Sans cat\u00e9gorie, il y a 30 min');
		} finally {
			i18n.locale = 'en';
		}
	});
});
