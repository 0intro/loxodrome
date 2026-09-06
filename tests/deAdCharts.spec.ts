import { describe, expect, it } from 'vitest';
import { rowToAerodromeLink } from '$lib/data/deAdcharts';
import { chartLink, DFS_VFR_EAIP_URL } from '$lib/data/airports';
import type { Airport } from '$lib/data/airports';

const BASE = 'https://aip.dfs.de/BasicVFR/pages/';

function ap(p: Partial<Airport>): Airport {
	return {
		ident: 'EDKA', type: 'small_airport', name: '', lat: 0, lon: 0,
		elevFt: null, transitionAltFt: null, country: 'DE', city: '', iata: '',
		runways: [], access: null, military: false, joint: false, vfr: false,
		ifr: false, radios: [], charts: [], source: 'de', ...p,
	};
}

describe('rowToAerodromeLink', () => {
	it('resolves the permalink against the stub base', () => {
		expect(rowToAerodromeLink(['EDKA', 'C0194C'], BASE)).toEqual({
			ident: 'EDKA',
			url: `${BASE}C0194C.html`,
		});
	});
});

describe('chartLink for Germany', () => {
	const deAdUrl = `${BASE}C0194C.html`;

	it('opens the per-aerodrome page when the index resolves one', () => {
		expect(chartLink(ap({}), undefined, null, deAdUrl)).toEqual({
			url: deAdUrl,
			kind: 'de-ad-page',
		});
	});

	it('falls back to the generic eAIP landing page for a field not in the index', () => {
		expect(chartLink(ap({ ident: 'EDXX' }), undefined, null, null)).toEqual({
			url: DFS_VFR_EAIP_URL,
			kind: 'de-ad',
		});
	});

	it('links a German heliport that is in the VFR index (HEL AD section)', () => {
		const heli = `${BASE}C0DEAD.html`;
		expect(chartLink(ap({ ident: 'EDMX', type: 'heliport' }), undefined, null, heli)).toEqual({
			url: heli,
			kind: 'de-ad-page',
		});
	});

	it('gives a German heliport NOT in the index no link (not the generic page)', () => {
		expect(chartLink(ap({ ident: 'EDXY', type: 'heliport' }), undefined, null, null)).toBeNull();
	});

	it('does not hand the German link to another publisher', () => {
		expect(chartLink(ap({ ident: 'LFPG', source: 'fr' }), undefined, null, deAdUrl)?.kind).not.toBe(
			'de-ad-page',
		);
	});
});
