/* The print menu's readiness line (components/flightprep/chartsPrefetch.ts
 * chartsReadiness, chartsText.ts readinessText): what a print now would carry
 * of the TEMSI / WINTEM, read through the print's own selection
 * (weather/tripCharts.ts selectFromCatalogs) over the catalogs as the cache
 * holds them, so the menu cannot promise what the paper will not carry. */

import { afterEach, describe, expect, it } from 'vitest';
import type { SofiaChart } from '$lib/sofia/charts';
import type { SofiaChartsEntry } from '$lib/state/sofiaCharts.svelte';
import { i18n } from '$lib/state/i18n.svelte';
import { chartsReadiness, type ChartPlan } from '$lib/components/flightprep/chartsPrefetch';
import { readinessText } from '$lib/components/flightprep/chartsText';

const H = 3_600_000;
/** 2026-10-02 00:00Z; at(h) = that day at h hours UTC. */
const T0 = Date.UTC(2026, 9, 2);
const at = (h: number): number => T0 + h * H;

const temsi = (h: number): SofiaChart => ({
	product: 'TEMSI',
	zone: 'FRANCE',
	level: 'FL20-150',
	deadline: `${h} UTC`,
	validAtMs: at(h),
	url: `https://aviation.meteo.fr/t${h}`,
});
const wintem = (h: number): SofiaChart => ({
	product: 'WINTEM',
	zone: 'FRANCE',
	level: 'FL20-100',
	deadline: `${h} UTC`,
	validAtMs: at(h),
	url: `https://aviation.meteo.fr/w${h}`,
});

function entry(p: Partial<SofiaChartsEntry> = {}): SofiaChartsEntry {
	return { status: 'ok', temsi: [], wintem: [], failures: {}, startedAtMs: at(10), fetchedAtMs: at(10), ...p };
}

/** A flight 11:00Z to 12:00Z over France at 4 500 ft. */
const PLAN: ChartPlan = {
	zones: ['FRANCE'],
	startMs: at(11),
	endMs: at(12),
	altRangeFt: { minFt: 4500, maxFt: 4500 },
};

afterEach(() => {
	i18n.locale = 'en';
});

describe('chartsReadiness', () => {
	it('says the flight is behind us before anything else', () => {
		const past = { startMs: at(-30), dayOnly: true };
		expect(chartsReadiness(PLAN, {}, at(10.8), past)).toEqual({ kind: 'past', past });
	});

	it('is still checking while a zone has no entry or is being asked', () => {
		expect(chartsReadiness(PLAN, {}, at(10.8), null)).toEqual({ kind: 'checking' });
		expect(chartsReadiness(PLAN, { FRANCE: entry({ status: 'loading' }) }, at(10.8), null)).toEqual({
			kind: 'checking',
		});
	});

	it('is the print\'s own selection over the catalogs as they stand', () => {
		const r = chartsReadiness(PLAN, { FRANCE: entry({ temsi: [temsi(12)], wintem: [wintem(12)] }) }, at(10.8), null);
		expect(r.kind).toBe('ready');
		if (r.kind === 'ready') {
			expect(r.picks.map((c) => c.url)).toEqual([temsi(12).url, wintem(12).url]);
			expect(r.notes).toEqual([]);
			expect(r.catalogFailures).toEqual([]);
		}
	});

	it('carries a catalog that could not be listed, the other product still read', () => {
		const failure = { code: 'upstream' as const, detail: 'HTTP 502' };
		const r = chartsReadiness(PLAN, { FRANCE: entry({ wintem: [wintem(12)], failures: { TEMSI: failure } }) }, at(10.8), null);
		expect(r.kind === 'ready' && r.catalogFailures).toEqual([{ zone: 'FRANCE', product: 'TEMSI', failure }]);
		expect(r.kind === 'ready' && r.picks.map((c) => c.product)).toEqual(['WINTEM']);
	});

	it('says a window wholly behind the clock is past, from its start', () => {
		const r = chartsReadiness(PLAN, { FRANCE: entry({ temsi: [temsi(12)] }) }, at(13), null);
		expect(r).toEqual({ kind: 'past', past: { startMs: at(11), dayOnly: false } });
	});
});

describe('readinessText', () => {
	it('lists the charts with their validity, then what is missing', () => {
		const failure = { code: 'timeout' as const, detail: 'signal timed out' };
		const text = readinessText(
			chartsReadiness(PLAN, { FRANCE: entry({ temsi: [temsi(12)], failures: { WINTEM: failure } }) }, at(10.8), null),
			at(10.8),
		);
		expect(text).toBe(
			'Charts printed now: TEMSI FRANCE FL20-150 12:00Z. WINTEM FRANCE: catalog unavailable. The request timed out.',
		);
	});

	it('says when the chart an extrapolated TEMSI stands in for comes out', () => {
		// 13:40Z to 15:00Z at 10:48Z: the 15Z TEMSI is out at 13Z, so the 12Z
		// one serves until then.
		const plan = { ...PLAN, startMs: at(13 + 40 / 60), endMs: at(15) };
		const text = readinessText(
			chartsReadiness(
				plan,
				{ FRANCE: entry({ temsi: [temsi(9), temsi(12)], wintem: [wintem(12), wintem(15)] }) },
				at(10.8),
				null,
			),
			at(10.8),
		);
		expect(text).toBe(
			'Charts printed now: TEMSI FRANCE FL20-150 12:00Z, WINTEM FRANCE FL20-100 15:00Z. TEMSI FRANCE valid 15:00Z: published around 13:00Z.',
		);
	});

	it('words the flight already flown and the checking state, in both languages', () => {
		expect(readinessText({ kind: 'checking' }, at(10))).toBe('Checking the TEMSI and WINTEM charts…');
		expect(readinessText({ kind: 'past', past: { startMs: Date.UTC(2026, 8, 28), dayOnly: true } }, at(10))).toBe(
			'The planned flight (2026-09-28) is in the past: check the flight date and the ETD.',
		);
		i18n.locale = 'fr';
		expect(readinessText({ kind: 'checking' }, at(10))).toBe('Vérification des cartes TEMSI et WINTEM…');
		const text = readinessText(
			chartsReadiness(PLAN, { FRANCE: entry({ temsi: [temsi(12)] }) }, at(10.8), null),
			at(10.8),
		);
		// A catalog listing nothing is said, not silent.
		expect(text).toBe(
			'Cartes imprimées maintenant\u202f: TEMSI FRANCE FL20-150 12:00Z. WINTEM FRANCE\u202f: SOFIA ne liste aucune carte.',
		);
	});

	it('says nothing with nothing to say', () => {
		expect(readinessText({ kind: 'ready', picks: [], notes: [], catalogFailures: [] }, at(10))).toBeNull();
	});
});
