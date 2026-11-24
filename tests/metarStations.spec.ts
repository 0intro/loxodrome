import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('the tile cache', () => {
	/** One tile, 48 to 52 N and 0 to 4 E. */
	const PARIS = { west: 0.5, south: 48.5, east: 3.5, north: 49.5 };
	const LFPO = {
		icaoId: 'LFPO',
		obsTime: Math.floor(Date.now() / 1000) - 20 * 60,
		rawOb: 'METAR LFPO 180230Z 24008KT CAVOK 09/05 Q1021',
		lat: 48.72,
		lon: 2.38,
		fltCat: 'VFR',
	} as AwcMetar;

	/** The /wx duck-typed response the awc client reads (ok + text()). */
	const answer = (rows: AwcMetar[]): unknown => ({
		ok: true,
		status: 200,
		text: () => Promise.resolve(JSON.stringify(rows)),
	});

	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	async function load() {
		const m = await import('$lib/state/metarStations.svelte');
		m.setShowStationsOnMap(true);
		const idents = (): string[] => m.stationFeed().map((st) => st.metar.icaoId).sort();
		return { ...m, idents };
	}

	it('says a failed tile while a sibling lands after it, until its own answer', async () => {
		// Two tiles: 48 N 0 E answers 502 at once, 48 N 4 E a moment later.
		const TWO = { west: 0.5, south: 48.5, east: 7.5, north: 49.5 };
		const EDDR = { ...LFPO, icaoId: 'EDDR', lat: 49.21, lon: 7.11 };
		const m = await load();
		let failWest = true;
		vi.stubGlobal(
			'fetch',
			vi.fn((url: string) =>
				decodeURIComponent(url).includes('bbox=48.00,0.00')
					? Promise.resolve(failWest ? { ok: false, status: 502 } : answer([LFPO]))
					: new Promise((r) => setTimeout(() => r(answer([EDDR])), 20)),
			),
		);
		m.ensureMetarStations(TWO);
		await vi.waitFor(() => expect(m.idents()).toEqual(['EDDR']));
		expect(m.metarStations.status).toBe('error');
		expect(m.metarStations.error).toBe('weather fetch failed: 502');

		failWest = false;
		m.refreshStations();
		m.ensureMetarStations(TWO);
		await vi.waitFor(() => expect(m.idents()).toEqual(['EDDR', 'LFPO']));
		await vi.waitFor(() => expect(m.metarStations.status).toBe('ok'));
		expect(m.metarStations.error).toBeNull();
	});

	it("keeps a tile's stations through a Refresh whose refetch fails", async () => {
		const m = await load();
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer([LFPO])));
		m.ensureMetarStations(PARIS);
		await vi.waitFor(() => expect(m.idents()).toEqual(['LFPO']));

		m.refreshStations();
		expect(m.idents()).toEqual(['LFPO']);
		const failing = vi.fn().mockRejectedValue(new Error('Failed to fetch'));
		vi.stubGlobal('fetch', failing);
		m.ensureMetarStations(PARIS);
		await vi.waitFor(() => expect(m.metarStations.status).toBe('error'));
		expect(failing).toHaveBeenCalledTimes(1);
		expect(m.idents()).toEqual(['LFPO']);
	});
});
