import { describe, expect, it } from 'vitest';
import { currentAiracIso } from '$lib/data/airac';
import {
	chartLink,
	enaireChartsUrl,
	groupChartsByFamily,
	ifrChartLink,
	natsAdUrl,
	siaAdUrl,
	siaAtlasVacUrl,
	siaVacUrl,
	skeyesAdUrl,
	type Airport,
	type AirportChart,
} from '$lib/data/airports';

function ap(p: Partial<Airport>): Airport {
	return {
		ident: 'XXXX',
		type: 'small_airport',
		name: '',
		lat: 0,
		lon: 0,
		elevFt: null,
		transitionAltFt: null,
		country: '',
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
		source: null,
		...p,
	};
}

// 2026-06-07 falls inside AIRAC cycle 2605, effective 2026-05-14.
const NOW = Date.UTC(2026, 5, 7);

describe('currentAiracIso', () => {
	it('formats the active cycle effective date as YYYY-MM-DD', () => {
		expect(currentAiracIso(NOW)).toBe('2026-05-14');
	});

	it('matches an effective-date boundary and the day before the next cycle', () => {
		expect(currentAiracIso(Date.UTC(2026, 4, 14))).toBe('2026-05-14');
		expect(currentAiracIso(Date.UTC(2026, 5, 10))).toBe('2026-05-14');
		expect(currentAiracIso(Date.UTC(2026, 5, 11))).toBe('2026-06-11');
	});
});

describe('natsAdUrl', () => {
	it('builds the NATS AD 2 page URL for the current cycle, upper-casing the ICAO', () => {
		expect(natsAdUrl('egll', false, NOW)).toBe(
			'https://www.aurora.nats.co.uk/htmlAIP/Publications/2026-05-14-AIRAC/html/eAIP/EG-AD-2.EGLL-en-GB.html',
		);
	});
});

describe('enaireChartsUrl', () => {
	it('builds the ENAIRE AIP viewer charts URL by ICAO (incl. Canary GC ICAOs)', () => {
		expect(enaireChartsUrl('LEMD')).toBe('https://aip.enaire.es/AIP/#LEMD');
		expect(enaireChartsUrl('gclp')).toBe('https://aip.enaire.es/AIP/#GCLP');
	});
});

describe('chartLink', () => {
	it('links a French aerodrome the Atlas VAC index carries to its Carte VAC PDF', () => {
		const link = chartLink(
			ap({ ident: 'LFPG', type: 'medium_airport' }),
			NOW, null, null, false, null, 'ad',
		);
		expect(link).toEqual({
			url: siaVacUrl('LFPG'),
			kind: 'fr-vac',
		});
	});

	it('offers no Carte VAC for a French field the Atlas VAC index does not carry', () => {
		// The membership is the gate, so an aerodrome with no plate (LFBC
		// Cazaux, military) and one whose index has not loaded yet answer
		// alike: no link, rather than the 404 the old shape heuristic gave.
		expect(chartLink(ap({ ident: 'LFBC', type: 'medium_airport', source: 'fr' }), NOW)).toBeNull();
		expect(chartLink(ap({ ident: 'LFPG', type: 'large_airport', source: 'fr' }), NOW)).toBeNull();
	});

	it('links a helistation to its AD-3 plate, keyed by the SIA national code', () => {
		const link = chartLink(
			ap({ ident: 'LF075', type: 'heliport', source: 'fr' }),
			NOW, null, null, false, null, 'hel',
		);
		expect(link).toEqual({ url: siaAtlasVacUrl('LF075', 3), kind: 'fr-vac' });
		expect(link?.url).toContain('/VACH/AD/AD-3.LF075.pdf');
	});

	it('picks the plate matching the field kind when both products carry it', () => {
		// The fifteen large aerodromes with their own helicopter chart: the
		// aerodrome panel opens the aerodrome plate, the panel's second link
		// (AirportDetail) offers the helicopter one.
		const ad = chartLink(
			ap({ ident: 'LFPG', type: 'large_airport', source: 'fr' }),
			NOW, null, null, false, null, 'both',
		);
		expect(ad?.url).toBe(siaVacUrl('LFPG'));
		const hel = chartLink(
			ap({ ident: 'LFPO', type: 'heliport', source: 'fr' }),
			NOW, null, null, false, null, 'both',
		);
		expect(hel?.url).toBe(siaAtlasVacUrl('LFPO', 3));
	});

	it('links a UK airport to the NATS AD 2 page', () => {
		const link = chartLink(ap({ ident: 'EGLL', type: 'large_airport', source: 'uk' }), NOW);
		expect(link?.kind).toBe('uk-ad');
		expect(link?.url).toBe(natsAdUrl('EGLL', false, NOW));
	});

	it('links a Channel Islands airport (Alderney) via the same UK NATS scheme', () => {
		const link = chartLink(ap({ ident: 'EGJA', type: 'small_airport', source: 'uk' }), NOW);
		expect(link?.url).toBe(natsAdUrl('EGJA', false, NOW));
	});

	it('links a Spanish airport (incl. Canaries) to the ENAIRE AIP charts page', () => {
		const md = chartLink(ap({ ident: 'LEMD', type: 'large_airport', source: 'es' }), NOW);
		expect(md?.url).toBe(enaireChartsUrl('LEMD'));
		expect(md?.kind).toBe('es-ad');
		expect(chartLink(ap({ ident: 'GCLP', type: 'large_airport', source: 'es' }), NOW)?.url).toBe(
			enaireChartsUrl('GCLP'),
		);
	});

	it('links a Spanish heliport to the ENAIRE viewer (it lists AD 3 charts)', () => {
		const link = chartLink(ap({ ident: 'GCAD', type: 'heliport', source: 'es' }), NOW);
		expect(link).toEqual({ url: enaireChartsUrl('GCAD'), kind: 'es-ad' });
	});

	it('skips a UK ICAO that is only in the OurAirports baseline (no NATS dataset membership)', () => {
		expect(chartLink(ap({ ident: 'EGLL', type: 'large_airport', source: null }), NOW)).toBeNull();
	});

	it('skips a non-charted French type and an unrelated baseline airport', () => {
		expect(chartLink(ap({ ident: 'LFPG', type: 'heliport' }), NOW)).toBeNull();
		expect(chartLink(ap({ ident: 'KJFK', type: 'large_airport', source: null }), NOW)).toBeNull();
	});

	it('links a Belgian aerodrome to the stable skeyes AD 2 page (no AIRAC date)', () => {
		const link = chartLink(ap({ ident: 'EBAW', type: 'medium_airport', source: 'be' }), NOW);
		expect(link).toEqual({ url: skeyesAdUrl('EBAW', false), kind: 'be-ad' });
		expect(link?.url).toBe(
			'https://ops.skeyes.be/html/belgocontrol_static/eaip/eAIP_Main/html/eAIP/EB-AD-2.EBAW-en-GB.html',
		);
	});

	it('links a Luxembourg aerodrome through the same joint-AIP scheme', () => {
		const link = chartLink(ap({ ident: 'ELLX', type: 'large_airport', source: 'be' }), NOW);
		expect(link?.url).toBe(skeyesAdUrl('ELLX', false));
	});

	it('links a Belgian heliport WITH stored charts to its AD 3 page', () => {
		const link = chartLink(
			ap({
				ident: 'EBCT',
				type: 'heliport',
				source: 'be',
				charts: [{ code: 'VAC', title: 'Visual Approach Chart', url: 'https://example.invalid/x.pdf' }],
			}),
			NOW,
		);
		expect(link?.url).toBe(skeyesAdUrl('EBCT', true));
		expect(link?.url).toContain('EB-AD-3.EBCT');
	});

	it('skips a chartless Belgian heliport and a baseline-only EB strip', () => {
		expect(chartLink(ap({ ident: 'EBAD', type: 'heliport', source: 'be' }), NOW)).toBeNull();
		expect(chartLink(ap({ ident: 'EBZZ', type: 'small_airport', source: null }), NOW)).toBeNull();
	});
});

describe('siaAdUrl', () => {
	it('builds the eAIP AD 2 page URL with both dated segments and the chart anchor', () => {
		expect(siaAdUrl('lfpo', false, NOW)).toBe(
			'https://www.sia.aviation-civile.gouv.fr/media/dvd/eAIP_14_MAY_2026/FRANCE/AIRAC-2026-05-14/html/eAIP/FR-AD-2.LFPO-fr-FR.html#AD-2.24.eAIP.LFPO',
		);
	});

	it('routes heliports to the AD 3 page and its AD 3.23 chart anchor', () => {
		expect(siaAdUrl('LFWF', true, NOW)).toBe(
			'https://www.sia.aviation-civile.gouv.fr/media/dvd/eAIP_14_MAY_2026/FRANCE/AIRAC-2026-05-14/html/eAIP/FR-AD-3.LFWF-fr-FR.html#AD-3.23.eAIP.LFWF',
		);
	});
});

describe('ifrChartLink', () => {
	it('links a French IFR aerodrome to its eAIP AD 2 page', () => {
		const link = ifrChartLink(
			ap({ ident: 'LFPG', type: 'medium_airport', ifr: true, source: 'fr' }),
			NOW,
		);
		expect(link).toEqual({ url: siaAdUrl('LFPG', false, NOW), kind: 'fr-ad' });
	});

	it('links a French IFR heliport to its AD 3 page', () => {
		const link = ifrChartLink(
			ap({ ident: 'LFWF', type: 'heliport', ifr: true, source: 'fr' }),
			NOW,
		);
		expect(link?.url).toBe(siaAdUrl('LFWF', true, NOW));
		expect(link?.url).toContain('FR-AD-3.LFWF');
	});

	it('skips VFR-only French fields (no eAIP aerodrome page is published)', () => {
		expect(ifrChartLink(ap({ ident: 'LFMW', type: 'small_airport', source: 'fr' }), NOW)).toBeNull();
	});

	it('skips ifr rows belonging to other eAIPs: French overseas and Jersey', () => {
		expect(
			ifrChartLink(ap({ ident: 'NTAA', type: 'large_airport', ifr: true, source: 'fr' }), NOW),
		).toBeNull();
		expect(
			ifrChartLink(ap({ ident: 'EGJJ', type: 'medium_airport', ifr: true, source: 'uk' }), NOW),
		).toBeNull();
	});

	it('skips baseline rows and non-charted French types', () => {
		expect(ifrChartLink(ap({ ident: 'KJFK', type: 'large_airport' }), NOW)).toBeNull();
		expect(
			ifrChartLink(ap({ ident: 'LFPG', type: 'closed', ifr: true, source: 'fr' }), NOW),
		).toBeNull();
	});

	it('widens the gate when stored eAIP charts prove the page exists (LFRJ)', () => {
		// Military-run civil pages: ifr stays false (no GAT FlightClass) but
		// the fr-adcharts scrape found the page's charts.
		const lfrj = ap({ ident: 'LFRJ', type: 'medium_airport', source: 'fr' });
		expect(ifrChartLink(lfrj, NOW)).toBeNull();
		expect(ifrChartLink(lfrj, NOW, true)).toEqual({
			url: siaAdUrl('LFRJ', false, NOW),
			kind: 'fr-ad',
		});
		// The LF prefix still gates: stored charts never make a non-LF link.
		expect(ifrChartLink(ap({ ident: 'EGJJ', type: 'medium_airport', source: 'uk' }), NOW, true)).toBeNull();
	});
});

describe('groupChartsByFamily', () => {
	let seq = 0;
	function chart(code: string): AirportChart {
		seq += 1;
		return { code, title: `T${seq}`, url: `https://example.invalid/${seq}.pdf` };
	}

	it('orders known families instrument-first regardless of stored order', () => {
		const stored = ['ADC', 'GMC', 'APDC', 'AOC', 'PATC', 'ATCSMAC', 'STAR', 'SID', 'IAC', 'VAC'];
		const groups = groupChartsByFamily(stored.map(chart));
		expect(groups.map((g) => g.code)).toEqual([
			'IAC', 'SID', 'STAR', 'VAC', 'ADC', 'GMC', 'APDC', 'AOC', 'PATC', 'ATCSMAC',
		]);
	});

	it('trails unknown and empty codes in first-appearance order, keeping stored order within a family', () => {
		const a = chart('IAC');
		const b = chart('');
		const c = chart('MISC');
		const d = chart('IAC');
		const groups = groupChartsByFamily([a, b, c, d]);
		expect(groups.map((g) => g.code)).toEqual(['IAC', '', 'MISC']);
		expect(groups[0].charts).toEqual([a, d]);
		expect(groups.reduce((n, g) => n + g.charts.length, 0)).toBe(4);
	});

	it('returns no groups for a chartless airport', () => {
		expect(groupChartsByFamily([])).toEqual([]);
	});

	it('sinks the SIA coding tables and text pages below the charts', () => {
		// A typical SIA page order: aerodrome sheets first, then the
		// instrument charts with their DATA coding tables interleaved.
		const stored = ['MIA', 'ADC', 'GMC', 'ENV', 'AMG', 'IAC', 'DATA', 'SID', 'DATA', 'STAR', 'TEXT', 'DEP', 'ARC'];
		const groups = groupChartsByFamily(stored.map(chart));
		expect(groups.map((g) => g.code)).toEqual([
			'IAC', 'SID', 'STAR', 'DEP', 'ARC', 'ENV', 'ADC', 'GMC', 'AMG', 'DATA', 'TEXT', 'MIA',
		]);
		expect(groups.find((g) => g.code === 'DATA')?.charts).toHaveLength(2);
	});
});
