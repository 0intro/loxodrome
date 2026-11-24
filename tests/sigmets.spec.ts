/* SIGMET normalisation (src/lib/weather/sigmet.ts) against live-recorded
 * AWC records (2026-07-05; public-domain data, verbatim): the two feed
 * shapes, the FL x 100 feet convention, epoch-second validity, the
 * hazard-family styling totality, and the filter predicates. Then the
 * session cache (src/lib/state/sigmets.svelte.ts) over a stubbed AWC
 * client: what a failed feed, a failed refresh and a closed gate keep. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from './helpers/storage';
import { en } from '$lib/i18n/en';
import { fr } from '$lib/i18n/fr';
import type { AwcAirsigmet, AwcIsigmet } from '$lib/weather/awc';
import {
	HAZARD_STYLES,
	fmtSigmetLevels,
	fromAirsigmet,
	fromIsigmet,
	ringAreaDeg2,
	sigmetActiveDuring,
	sigmetInBand,
	sigmetLabel,
	uniqueSigmetIds,
	type Sigmet,
	type SigmetHazard,
} from '$lib/weather/sigmet';

vi.mock('$lib/weather/awc', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/weather/awc')>()),
	fetchIsigmets: vi.fn(),
	fetchAirsigmets: vi.fn(),
}));

/** Recorded from /api/data/isigmet (Johannesburg FIR, SEV TURB). */
const INTL: AwcIsigmet = {
	icaoId: 'FAOR',
	firId: 'FAJA',
	firName: 'FAJA JOHANNESBURG',
	seriesId: 'A01',
	hazard: 'TURB',
	qualifier: 'SEV',
	base: 24000,
	top: 30000,
	geom: 'AREA',
	coords: [
		{ lon: 26.867, lat: -24.117 },
		{ lon: 32.017, lat: -24.75 },
		{ lon: 32.05, lat: -25.033 },
		{ lon: 26.867, lat: -24.117 },
	],
	dir: null,
	spd: null,
	validTimeFrom: 1783203120,
	validTimeTo: 1783216800,
	rawSigmet:
		'WSZA21 FAOR 042212\nFAJA SIGMET A01 VALID 042212/050200 FAOR-\nFAJA JOHANNESBURG FIR SEV TURB FCST WI\nS2407 E02652 - S2445 E03201 FL240/300=',
};

/** Recorded from /api/data/airsigmet (convective SIGMET 13W, tops-only). */
const US: AwcAirsigmet = {
	icaoId: 'KKCI',
	seriesId: '13W',
	airSigmetType: 'SIGMET',
	hazard: 'CONVECTIVE',
	severity: 5,
	altitudeLow1: null,
	altitudeLow2: null,
	altitudeHi1: 41000,
	altitudeHi2: 41000,
	movementDir: null,
	movementSpd: null,
	coords: [
		{ lat: 32.522, lon: -105.444 },
		{ lat: 30.491, lon: -103.411 },
		{ lat: 31.0, lon: -104.5 },
	],
	validTimeFrom: 1783205700,
	validTimeTo: 1783212900,
	rawAirSigmet: 'WSUS33 KKCI 042255\nSIGW\nCONVECTIVE SIGMET 13W\nAREA TS MOV LTL. TOPS TO FL410.',
};

describe('fromIsigmet', () => {
	const s = fromIsigmet(INTL);

	it('normalises the international record', () => {
		expect(s.id).toBe('FAOR|A01|1783203120|-24.117,26.867,4');
		expect(s.source).toBe('intl');
		expect(s.fir).toBe('FAJA');
		expect(s.hazard).toBe('TURB');
		expect(s.qualifier).toBe('SEV');
		expect(s.baseFt).toBe(24000);
		expect(s.topFt).toBe(30000);
		expect(s.validFromMs).toBe(1783203120_000);
		expect(s.validToMs).toBe(1783216800_000);
		expect(s.ring).toHaveLength(4);
		expect(s.ring?.[0]).toEqual([-24.117, 26.867]);
		expect(s.raw).toContain('SEV TURB');
	});

	it('labels with qualifier, hazard and FL levels', () => {
		expect(sigmetLabel(s, en.weather.sigmet)).toBe('SEV TURB FL240-FL300');
	});

	it('keeps a FIR-wide advisory (no coords) with a null ring', () => {
		const wide = fromIsigmet({ ...INTL, coords: null });
		expect(wide.ring).toBeNull();
		expect(wide.id).toBe('FAOR|A01|1783203120|fir');
		const short = fromIsigmet({ ...INTL, coords: [{ lat: 0, lon: 0 }] });
		expect(short.ring).toBeNull();
	});

	it('gives the areas of one AREAS bulletin distinct, stable ids', () => {
		// AWC emits a multi-area bulletin as several records sharing office,
		// series and validity; the each-key and the selection need per-record
		// ids that survive a refetch.
		const a = fromIsigmet(INTL);
		const b = fromIsigmet({
			...INTL,
			coords: [
				{ lat: -30, lon: 20 },
				{ lat: -31, lon: 21 },
				{ lat: -32, lon: 20 },
			],
		});
		expect(a.id).not.toBe(b.id);
		expect(fromIsigmet(INTL).id).toBe(a.id);
	});

	it('uniquifies ids the ring suffix cannot separate (live WIII collision)', () => {
		// 2026-07-05: two records shared office, series, validity AND the
		// ring's first vertex + size (differing only mid-ring), so the
		// suffix collided and the duplicate key crashed the Weather tab's
		// keyed each. The merge pass must yield unique ids whatever AWC
		// emits, leaving already-distinct ids untouched.
		const a = fromIsigmet(INTL);
		const twin = fromIsigmet({
			...INTL,
			coords: INTL.coords!.map((c, i) => (i === 1 ? { lat: c.lat + 1, lon: c.lon } : c)),
		});
		const other = fromIsigmet({ ...INTL, seriesId: 'A02' });
		expect(twin.id).toBe(a.id);
		const out = uniqueSigmetIds([a, twin, other]);
		expect(out.map((s) => s.id)).toEqual([a.id, `${a.id}#2`, other.id]);
		expect(new Set(out.map((s) => s.id)).size).toBe(3);
	});

	it('nulls non-numeric movement and altitude values (live "STNR" dirs)', () => {
		const stnr = fromIsigmet({
			...INTL,
			dir: 'STNR' as unknown as number,
			spd: 0,
			base: 'SFC' as unknown as number,
		});
		expect(stnr.dirDeg).toBeNull();
		expect(stnr.spdKt).toBe(0);
		expect(stnr.baseFt).toBeNull();
	});

	it('drops non-finite vertices instead of crashing the draw', () => {
		const dirty = fromIsigmet({
			...INTL,
			coords: [
				{ lat: -24, lon: 26 },
				{ lat: Number.NaN, lon: 30 },
				{ lat: -25, lon: 27 },
				{ lat: -26, lon: 26 },
			],
		});
		expect(dirty.ring).toHaveLength(3);
		const allBad = fromIsigmet({
			...INTL,
			coords: [
				{ lat: Number.NaN, lon: 26 },
				{ lat: -25, lon: Number.NaN },
			],
		});
		expect(allBad.ring).toBeNull();
	});
});

describe('fromAirsigmet', () => {
	const s = fromAirsigmet(US);

	it('normalises the US record, CONVECTIVE joining the TS family', () => {
		expect(s.id).toBe('KKCI|13W|1783205700|32.522,-105.444,3');
		expect(s.source).toBe('us');
		expect(s.fir).toBeNull();
		expect(s.hazard).toBe('TS');
		expect(s.hazardRaw).toBe('CONVECTIVE');
		expect(s.baseFt).toBeNull();
		expect(s.topFt).toBe(41000);
	});

	it('labels a tops-only advisory as below its top', () => {
		expect(fmtSigmetLevels(s, en.weather.sigmet)).toBe('below FL410');
		expect(sigmetLabel(s, en.weather.sigmet)).toBe('CONVECTIVE below FL410');
	});
});

describe('hazard styling', () => {
	it('styles every family and never drops an unknown hazard', () => {
		const known: SigmetHazard[] = ['TS', 'TURB', 'ICE', 'MTW', 'VA', 'TC', 'OTHER'];
		for (const h of known) {
			expect(HAZARD_STYLES[h].color).toMatch(/^#[0-9A-F]{6}$/i);
			expect(HAZARD_STYLES[h].label.length).toBeGreaterThan(0);
		}
		const odd = fromIsigmet({ ...INTL, hazard: 'DS' });
		expect(odd.hazard).toBe('OTHER');
		expect(odd.hazardRaw).toBe('DS');
		expect(HAZARD_STYLES[odd.hazard].color).toBe('#546E7A');
	});

	it('puts a volcano qualifier after the VA hazard word', () => {
		const va = fromIsigmet({ ...INTL, hazard: 'VA', qualifier: 'SEMERU', base: null, top: 48000 });
		expect(sigmetLabel(va, en.weather.sigmet)).toBe('VA SEMERU below FL480');
		expect(sigmetLabel(va, fr.weather.sigmet)).toBe('VA SEMERU sous le FL480');
	});
});

describe('filter predicates', () => {
	const s = fromIsigmet(INTL);

	it('overlaps validity windows inclusively', () => {
		expect(sigmetActiveDuring(s, s.validFromMs - 1000, s.validFromMs)).toBe(true);
		expect(sigmetActiveDuring(s, s.validToMs, Infinity)).toBe(true);
		expect(sigmetActiveDuring(s, s.validToMs + 1, Infinity)).toBe(false);
		expect(sigmetActiveDuring(s, 0, s.validFromMs - 1)).toBe(false);
	});

	it('overlaps the altitude band conservatively at missing endpoints', () => {
		expect(sigmetInBand(s, null)).toBe(true);
		expect(sigmetInBand(s, { floor: 0, ceiling: 23_999 })).toBe(false);
		expect(sigmetInBand(s, { floor: 25_000, ceiling: 26_000 })).toBe(true);
		const us = fromAirsigmet(US);
		// Base null reaches the surface; top null is unbounded.
		expect(sigmetInBand(us, { floor: 0, ceiling: 500 })).toBe(true);
		expect(sigmetInBand(fromIsigmet({ ...INTL, top: null }), { floor: 60_000, ceiling: 99_000 })).toBe(true);
	});
});

describe('ringAreaDeg2', () => {
	it('orders rings by area for the smallest-wins hit-test', () => {
		const small: [number, number][] = [[0, 0], [0, 1], [1, 1], [1, 0]];
		const big: [number, number][] = [[0, 0], [0, 3], [3, 3], [3, 0]];
		expect(ringAreaDeg2(small)).toBeCloseTo(1, 6);
		expect(ringAreaDeg2(big)).toBeGreaterThan(ringAreaDeg2(small));
	});
});

describe('the session cache', () => {
	const TTL_MS = 5 * 60_000;
	const nowS = Math.floor(Date.now() / 1000);
	/** In force from an hour ago to three hours on, and from 4 000 to 12 000
	 *  ft, so the Now window and the default level band both list it. */
	const LFFF: AwcIsigmet = {
		...INTL,
		icaoId: 'LFPW',
		firId: 'LFFF',
		firName: 'LFFF PARIS',
		hazard: 'ICE',
		base: 4000,
		top: 12000,
		coords: [
			{ lat: 48, lon: 2 },
			{ lat: 49, lon: 3 },
			{ lat: 48, lon: 4 },
			{ lat: 48, lon: 2 },
		],
		validTimeFrom: nowS - 3600,
		validTimeTo: nowS + 3 * 3600,
	};
	const KKCI: AwcAirsigmet = { ...US, validTimeFrom: nowS - 3600, validTimeTo: nowS + 3600 };

	beforeEach(() => {
		vi.resetModules();
		vi.stubGlobal('localStorage', memoryStorage());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	async function load() {
		const awc = await import('$lib/weather/awc');
		const m = await import('$lib/state/sigmets.svelte');
		m.sigmets.tabOpen = true;
		return { ...m, intl: vi.mocked(awc.fetchIsigmets), us: vi.mocked(awc.fetchAirsigmets) };
	}

	/** The cache's promise chain has run to its end. */
	const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
	const firs = (list: Sigmet[]): (string | null)[] => list.map((s) => s.fir ?? s.source);

	it('keeps a failed feed\'s advisories and says which feed failed', async () => {
		const m = await load();
		m.intl.mockResolvedValue([LFFF]);
		m.us.mockResolvedValue([KKCI]);
		m.ensureSigmets();
		await settle();
		expect(m.sigmets.status).toBe('ok');
		expect(firs(m.visibleSigmets())).toEqual(['LFFF', 'us']);

		m.intl.mockRejectedValue(new Error('weather fetch failed: 502'));
		m.ensureSigmets(Date.now() + TTL_MS);
		await settle();
		expect(m.intl).toHaveBeenCalledTimes(2);
		expect(m.sigmets.status).toBe('error');
		expect(m.sigmets.failed).toBe('intl');
		expect(m.sigmets.error).toBe('weather fetch failed: 502');
		expect(firs(m.visibleSigmets())).toEqual(['LFFF', 'us']);
	});

	it('reads a first answer missing one feed as an error', async () => {
		const m = await load();
		m.intl.mockRejectedValue(new Error('signal timed out'));
		m.us.mockResolvedValue([KKCI]);
		m.ensureSigmets();
		await settle();
		expect(m.sigmets.status).toBe('error');
		expect(m.sigmets.failed).toBe('intl');
		expect(firs(m.visibleSigmets())).toEqual(['us']);
	});

	it('names both feeds when neither answers', async () => {
		const m = await load();
		m.intl.mockRejectedValue(new Error('Failed to fetch'));
		m.us.mockRejectedValue(new Error('weather fetch failed: 503'));
		m.ensureSigmets();
		await settle();
		expect(m.sigmets.status).toBe('error');
		expect(m.sigmets.failed).toBe('both');
		expect(m.sigmets.error).toBe('Failed to fetch');
	});

	it('still says a failure after the gate closes and reopens inside the TTL', async () => {
		const m = await load();
		m.intl.mockResolvedValue([LFFF]);
		m.us.mockResolvedValue([KKCI]);
		m.ensureSigmets();
		await settle();
		const answeredAt = m.sigmets.fetchedAtMs;
		expect(answeredAt).toBeGreaterThan(0);

		m.intl.mockRejectedValue(new Error('Failed to fetch'));
		m.us.mockRejectedValue(new Error('Failed to fetch'));
		m.ensureSigmets(Date.now() + TTL_MS);
		await settle();
		expect(m.sigmets.status).toBe('error');
		// The age the tab prints is the last answer's, never the failure's.
		expect(m.sigmets.fetchedAtMs).toBe(answeredAt);

		m.sigmets.tabOpen = false;
		m.ensureSigmets();
		m.sigmets.tabOpen = true;
		m.ensureSigmets(Date.now() + 60_000);
		await settle();
		expect(m.intl).toHaveBeenCalledTimes(2);
		expect(m.sigmets.status).toBe('error');
		expect(m.sigmets.failed).toBe('both');
		expect(firs(m.visibleSigmets())).toEqual(['LFFF', 'us']);
	});

	it('says a failure with nothing held after the gate closes and reopens', async () => {
		const m = await load();
		m.intl.mockRejectedValue(new Error('Failed to fetch'));
		m.us.mockRejectedValue(new Error('Failed to fetch'));
		m.ensureSigmets();
		await settle();
		m.sigmets.tabOpen = false;
		m.ensureSigmets();
		m.sigmets.tabOpen = true;
		m.ensureSigmets(Date.now() + 60_000);
		expect(m.sigmets.status).toBe('error');
		expect(m.sigmets.fetchedAtMs).toBe(0);
	});

	it('keeps the held advisories through a Refresh until an answer replaces them', async () => {
		const m = await load();
		m.intl.mockResolvedValue([LFFF]);
		m.us.mockResolvedValue([KKCI]);
		m.ensureSigmets();
		await settle();

		m.refreshSigmets();
		expect(firs(m.visibleSigmets())).toEqual(['LFFF', 'us']);
		m.intl.mockRejectedValue(new Error('Failed to fetch'));
		m.us.mockRejectedValue(new Error('Failed to fetch'));
		m.ensureSigmets();
		await settle();
		expect(m.intl).toHaveBeenCalledTimes(2);
		expect(m.sigmets.status).toBe('error');
		expect(firs(m.visibleSigmets())).toEqual(['LFFF', 'us']);
		expect(m.sigmetById(m.visibleSigmets()[0].id)?.fir).toBe('LFFF');

		m.intl.mockResolvedValue([]);
		m.us.mockResolvedValue([KKCI]);
		m.refreshSigmets();
		m.ensureSigmets();
		await settle();
		expect(m.sigmets.status).toBe('ok');
		expect(firs(m.visibleSigmets())).toEqual(['us']);
	});
});
