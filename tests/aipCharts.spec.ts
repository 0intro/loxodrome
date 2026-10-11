import { describe, expect, it } from 'vitest';
import { AIP_CHART_INDEXES, aipChartIndexFor, aipChartsUrl } from '$lib/data/aipCharts';
import { rowToAerodromeLinks } from '$lib/data/atAdcharts';
import { chartLink, type Airport } from '$lib/data/airports';
import { PUBLISHERS } from '$lib/data/publishers';

function ap(p: Partial<Airport>): Airport {
	return {
		ident: 'EFJY',
		type: 'medium_airport',
		name: '',
		lat: 0,
		lon: 0,
		elevFt: null,
		transitionAltFt: null,
		country: 'FI',
		city: '',
		iata: '',
		runways: [],
		access: null,
		military: false,
		joint: false,
		vfr: false,
		ifr: false,
		radios: [],
		charts: [],
		pads: [],
		source: null,
		...p,
	};
}

describe('the eAIP chart indexes', () => {
	it('are found by the ICAO prefix, whoever published the airport row', () => {
		expect(aipChartIndexFor('EFJY')?.id).toBe('fi');
		expect(aipChartIndexFor('lkpr')?.id).toBe('cz');
		// Serbia and Montenegro share SMATSA's one AIP.
		expect(aipChartIndexFor('LYTV')?.id).toBe('rs');
		expect(aipChartIndexFor('ESCM')?.id).toBe('se');
		expect(aipChartIndexFor('EHLE')?.id).toBe('nl');
		expect(aipChartIndexFor('GCLP')?.id).toBe('es');
		expect(aipChartIndexFor('LROP')?.id).toBe('ro');
		// Naviair's tree carries the Faroes (EK) and Greenland (BG) too.
		expect(aipChartIndexFor('EKVG')?.id).toBe('dk');
		expect(aipChartIndexFor('BGSF')?.id).toBe('dk');
		// Spain's viewer also lists Gibraltar, which its index leaves out.
		expect(aipChartIndexFor('LXGB')).toBeNull();
		expect(aipChartIndexFor('LFPG')).toBeNull();
		expect(aipChartIndexFor('EF')).toBeNull();
	});

	it('claim each ICAO prefix once', () => {
		const prefixes = AIP_CHART_INDEXES.flatMap((x) => [...x.prefixes]);
		expect(new Set(prefixes).size).toBe(prefixes.length);
	});

	it('are named by the file cmd/eaip writes', () => {
		expect(aipChartsUrl('no')).toBe('/data/no-adcharts.json');
		expect(aipChartsUrl('no', true)).toBe('/data/no-adcharts.next.json');
	});

	it('cover held States the registry does not publish, and only those beside the shipped cohort', () => {
		const ids = AIP_CHART_INDEXES.map((x) => x.id);
		const registry = new Set<string>(PUBLISHERS);
		// The shipped cohort States are registry publishers, and so are the
		// three whose airspace another command reads and Romania, whose
		// obstacles cmd/ro reads; the rest are held.
		expect(ids.filter((id) => registry.has(id)).sort()).toEqual(['es', 'fi', 'ie', 'is', 'nl', 'ro', 'rs', 'se', 'sk', 'xk']);
	});
});

describe('an eAIP chart row', () => {
	it('keeps a path already absolute and resolves the rest against the base', () => {
		const links = rowToAerodromeLinks(
			[
				'EFJY',
				'eAIP/EF-AD%202%20EFJY%20-%20JYV%C3%84SKYL%C3%84%201-en-GB.html',
				[
					['VAC', 'VAC', 'documents/Root_WePub/ANSFI/Charts/AD/EFJY/EF_AD_2_EFJY_VAC.pdf'],
					['MISC', 'Elsewhere', 'https://example.org/x.pdf'],
				],
			],
			'https://www.ais.fi/eaip/06%20AUG%202026_2026_08_06/',
		);
		expect(links.adUrl).toBe(
			'https://www.ais.fi/eaip/06%20AUG%202026_2026_08_06/eAIP/EF-AD%202%20EFJY%20-%20JYV%C3%84SKYL%C3%84%201-en-GB.html',
		);
		expect(links.charts.map((c) => c.url)).toEqual([
			'https://www.ais.fi/eaip/06%20AUG%202026_2026_08_06/documents/Root_WePub/ANSFI/Charts/AD/EFJY/EF_AD_2_EFJY_VAC.pdf',
			'https://example.org/x.pdf',
		]);
	});
});

describe('chartLink for an eAIP State', () => {
	it('opens the aerodrome page the index lists, naming its publisher', () => {
		const link = chartLink(ap({}), undefined, null, null, false, null, null, {
			adUrl: 'https://www.ais.fi/eaip/x/eAIP/EF-AD%202%20EFJY%201-en-GB.html',
			publisher: 'Fintraffic ANS',
		});
		expect(link).toEqual({
			url: 'https://www.ais.fi/eaip/x/eAIP/EF-AD%202%20EFJY%201-en-GB.html',
			kind: 'aip-ad',
			publisher: 'Fintraffic ANS',
		});
	});

	it('offers nothing where no index lists the field', () => {
		expect(chartLink(ap({}), undefined, null, null, false, null, null, null)).toBeNull();
	});
});
