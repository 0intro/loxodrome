import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadMetarStations } from '$lib/data/metarStations';

/* Pins the METAR station catalog loader: the positional {fields, rows} decode
 * (which must stay in lockstep with cmd/metar/build.go's outputFields) and the
 * fail-soft behaviour a missing/undeployed file relies on. */

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('loadMetarStations', () => {
	it('decodes the positional {fields, rows} shape into typed records', async () => {
		const raw = {
			fields: [
				'icaoId', 'iata', 'faa', 'wmo', 'site', 'lat', 'lon',
				'elev', 'country', 'region', 'priority', 'taf',
			],
			rows: [
				['LFPG', 'CDG', '', '07157', 'Paris/De Gaulle Arpt', 49.015, 2.534, 107, 'FR', 'ID', 5, true],
				['KDEN', 'DEN', 'DEN', '72565', 'Denver Intl', 39.84657, -104.65623, 1656, 'US', 'CO', 0, true],
				// WMO-only platform: numeric ident, no IATA, null elevation, no TAF.
				['62050', '', '', '62050', 'North Sea Platform', 30, 19, null, 'LY', '', 9, false],
			],
		};
		vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(raw))));

		const list = await loadMetarStations('/data/metar-stations.json');
		expect(list).toHaveLength(3);
		expect(list[0]).toEqual({
			icaoId: 'LFPG',
			iata: 'CDG',
			faa: '',
			wmo: '07157',
			site: 'Paris/De Gaulle Arpt',
			lat: 49.015,
			lon: 2.534,
			elevM: 107,
			country: 'FR',
			region: 'ID',
			taf: true,
		});
		expect(list[1]).toMatchObject({ icaoId: 'KDEN', faa: 'DEN', elevM: 1656 });
		expect(list[2]).toMatchObject({ icaoId: '62050', iata: '', elevM: null, taf: false });
	});

	it('is fail-soft: an HTTP error resolves to [] (map keeps rendering)', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('nope', { status: 404 }))));
		expect(await loadMetarStations('/data/metar-stations.json')).toEqual([]);
	});

	it('is fail-soft: a non-JSON 200 (Vite dev SPA fallback) resolves to []', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.stubGlobal(
			'fetch',
			vi.fn(() =>
				Promise.resolve(
					new Response('<!doctype html>', {
						status: 200,
						headers: { 'content-type': 'text/html' },
					}),
				),
			),
		);
		expect(await loadMetarStations('/data/metar-stations.json')).toEqual([]);
	});
});
