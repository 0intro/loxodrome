/* Pins the printed meteo annex's chart selection (src/lib/weather/
 * tripCharts.ts): the flight-level parse, the planned-altitude range, the
 * FRANCE / EUROC zone pick, and selectTripCharts' cover-window + WINTEM
 * level-bracketing rules, incl. the degradation notes that keep a missing
 * TEMSI from reading as "no significant weather applies". Catalog shapes
 * mirror the live SOFIA probes of 2026-07-07 (TEMSI FRANCE 3-hourly and
 * published only ~1-2 h ahead; WINTEM FRANCE fl020/050/100 3-hourly; WINTEM
 * EUROC fl050/180/340 6-hourly). */

import { describe, it, expect } from 'vitest';
import type { SofiaChart } from '$lib/sofia/charts';
import {
	altRange,
	chartZones,
	parseChartFl,
	selectTripCharts,
	type ChartSelection,
} from '$lib/weather/tripCharts';

const H = 3_600_000;
/** 2026-07-07 00:00Z; hours(h) = that day at h hours UTC. */
const T0 = Date.UTC(2026, 6, 7);
const at = (h: number): number => T0 + h * H;

let seq = 0;
function chart(p: Partial<SofiaChart> & { product: SofiaChart['product'] }): SofiaChart {
	return {
		level: null,
		zone: 'FRANCE',
		deadline: '',
		validAtMs: null,
		url: `https://aviation.meteo.fr/FR/aviation/affiche_image.php?login=t&layer=l&echeance=${seq++}`,
		...p,
	};
}

function temsiFrance(hours: number[]): SofiaChart[] {
	return hours.map((h) =>
		chart({ product: 'TEMSI', level: 'FL20-150', validAtMs: at(h), deadline: `${h} UTC` }),
	);
}

function temsiEuroc(hours: number[]): SofiaChart[] {
	return hours.map((h) =>
		chart({ product: 'TEMSI', zone: 'EUROC', level: 'FL20-450', validAtMs: at(h) }),
	);
}

function wintem(zone: string, level: string, hours: number[]): SofiaChart[] {
	return hours.map((h) => chart({ product: 'WINTEM', zone, level, validAtMs: at(h) }));
}

function select(
	charts: SofiaChart[],
	windowH: [number, number],
	range: { minFt: number; maxFt: number } | null,
): ChartSelection {
	return selectTripCharts(charts, {
		windowStartMs: at(windowH[0]),
		windowEndMs: at(windowH[1]),
		altRangeFt: range,
	});
}

const label = (c: SofiaChart): string =>
	`${c.product} ${c.zone} ${c.level ?? ''} ${(c.validAtMs! - T0) / H}h`.replace('  ', ' ');

describe('parseChartFl', () => {
	it('parses the padded link levels, feet = FL x 100', () => {
		expect(parseChartFl('FL020')).toBe(2000);
		expect(parseChartFl('FL115')).toBe(11500);
	});

	it('rejects bands and anything else', () => {
		expect(parseChartFl('FL20-150')).toBeNull();
		expect(parseChartFl('SFC')).toBeNull();
		expect(parseChartFl('')).toBeNull();
		expect(parseChartFl(null)).toBeNull();
	});
});

describe('altRange', () => {
	it('spans every printed leg', () => {
		expect(altRange([[2000, 4500], [3000]])).toEqual({ minFt: 2000, maxFt: 4500 });
	});

	it('null without a finite leg', () => {
		expect(altRange([])).toBeNull();
		expect(altRange([[]])).toBeNull();
		expect(altRange([[Number.NaN]])).toBeNull();
	});
});

describe('chartZones', () => {
	const paris = [[{ lat: 48.8, lon: 2.6 }]];
	const london = [[{ lat: 51.5, lon: -0.5 }]];
	const texas = [[{ lat: 32.8, lon: -97.0 }]];

	it('FRANCE when the FIR data is unavailable', () => {
		expect(chartZones(null, paris)).toEqual(['FRANCE']);
	});

	it('FRANCE for a domestic flight', () => {
		expect(chartZones({ inside: true, outside: false }, paris)).toEqual(['FRANCE']);
	});

	it('adds EUROC when the route leaves the French FIRs within Europe', () => {
		expect(chartZones({ inside: true, outside: true }, [...paris, ...london])).toEqual([
			'FRANCE',
			'EUROC',
		]);
	});

	it('EUROC alone for a wholly foreign European flight', () => {
		expect(chartZones({ inside: false, outside: true }, london)).toEqual(['EUROC']);
	});

	it('nothing outside EUROC coverage (a Texas flight prints no charts)', () => {
		expect(chartZones({ inside: false, outside: true }, texas)).toEqual([]);
	});

	it('FRANCE when there is nothing to test', () => {
		expect(chartZones({ inside: false, outside: false }, [])).toEqual(['FRANCE']);
	});
});

describe('selectTripCharts, TEMSI cover windows', () => {
	it('keeps every validity covering the flight window', () => {
		const { picks, notes } = select(temsiFrance([6, 9, 12, 15]), [8, 13], null);
		expect(picks.map(label)).toEqual(['TEMSI FRANCE FL20-150 9h', 'TEMSI FRANCE FL20-150 12h']);
		expect(notes).toEqual([]);
	});

	it('an exact windowEnd === coverStart boundary stays half-open', () => {
		// Covers: 06 -> [4:30, 7:30), 09 -> [7:30, 10:30). A window starting
		// exactly 7:30 belongs to the 09 chart alone.
		const { picks } = select(temsiFrance([6, 9]), [7.5, 9], null);
		expect(picks.map(label)).toEqual(['TEMSI FRANCE FL20-150 9h']);
	});

	it('a lone chart covers half the nominal 3 h step each side', () => {
		const { picks } = select(temsiFrance([9]), [10, 11], null);
		expect(picks.map(label)).toEqual(['TEMSI FRANCE FL20-150 9h']);
		expect(select(temsiFrance([9]), [10.5, 11], null).picks).toEqual([]);
	});

	it('a flight beyond the catalog notes "not yet published" instead of silence', () => {
		// The live reality: TEMSI FRANCE appears ~1-2 h before validity, so an
		// 11:00-13:00 window printed at 08:00 has no covering chart yet.
		const { picks, notes } = select(temsiFrance([6, 9]), [11, 13], null);
		expect(picks).toEqual([]);
		expect(notes).toEqual([{ product: 'TEMSI', zone: 'FRANCE', kind: 'not-yet-published' }]);
	});

	it('a window before the catalog prints nothing, silently', () => {
		const { picks, notes } = select(temsiFrance([6, 9]), [1, 3], null);
		expect(picks).toEqual([]);
		expect(notes).toEqual([]);
	});

	it('an undated group feeds a note', () => {
		const undated = [chart({ product: 'TEMSI', level: 'FL20-150' })];
		const { picks, notes } = select(undated, [8, 13], null);
		expect(picks).toEqual([]);
		expect(notes).toEqual([{ product: 'TEMSI', zone: 'FRANCE', kind: 'undated' }]);
	});
});

describe('selectTripCharts, WINTEM levels', () => {
	const franceLadder = [
		...wintem('FRANCE', 'FL020', [6, 9, 12, 15]),
		...wintem('FRANCE', 'FL050', [6, 9, 12, 15]),
		...wintem('FRANCE', 'FL100', [6, 9, 12, 15]),
	];

	it('brackets the cruise and picks the validity nearest mid-flight', () => {
		// Cruise 4500 ft between FL020 and FL050; window 10:00-13:30, mid
		// 11:45, covering validities 09 and 12 -> 12 wins per level.
		const { picks } = select(franceLadder, [10, 13.5], { minFt: 4500, maxFt: 4500 });
		expect(picks.map(label)).toEqual(['WINTEM FRANCE FL020 12h', 'WINTEM FRANCE FL050 12h']);
	});

	it('a climb range keeps every level within plus the brackets', () => {
		const { picks } = select(franceLadder, [10, 13.5], { minFt: 1000, maxFt: 9500 });
		expect(picks.map((c) => c.level)).toEqual(['FL020', 'FL050', 'FL100']);
	});

	it('below the lowest level only the first level above prints', () => {
		const { picks } = select(franceLadder, [10, 13.5], { minFt: 800, maxFt: 800 });
		expect(picks.map((c) => c.level)).toEqual(['FL020']);
	});

	it('above the highest level only the last level below prints', () => {
		const { picks } = select(franceLadder, [10, 13.5], { minFt: 15000, maxFt: 15000 });
		expect(picks.map((c) => c.level)).toEqual(['FL100']);
	});

	it('no altitude range skips WINTEM and keeps TEMSI', () => {
		const { picks } = select([...temsiFrance([9, 12]), ...franceLadder], [10, 13.5], null);
		expect(picks.every((c) => c.product === 'TEMSI')).toBe(true);
		expect(picks).toHaveLength(2);
	});

	it('levels bracket per zone: EUROC keeps its own ladder', () => {
		// Cruise 4500: FRANCE brackets FL020+FL050; EUROC (fl050/180/340) has
		// nothing below 4500, so only its FL050 is relevant.
		const euroc = [
			...wintem('EUROC', 'FL050', [6, 12, 18]),
			...wintem('EUROC', 'FL180', [6, 12, 18]),
			...wintem('EUROC', 'FL340', [6, 12, 18]),
		];
		const { picks } = select([...franceLadder, ...euroc], [10, 13.5], {
			minFt: 4500,
			maxFt: 4500,
		});
		expect(picks.map(label)).toEqual([
			'WINTEM FRANCE FL020 12h',
			'WINTEM FRANCE FL050 12h',
			'WINTEM EUROC FL050 12h',
		]);
	});

	it('a 6-hourly group keeps 6-hourly edge covers', () => {
		// WINTEM EUROC 06/12/18: the 18:00 chart's trailing cover runs to
		// 21:00 (median gap), so a 19:00-21:00 evening window still picks it.
		const euroc = wintem('EUROC', 'FL050', [6, 12, 18]);
		const { picks } = select(euroc, [19, 21], { minFt: 4500, maxFt: 4500 });
		expect(picks.map(label)).toEqual(['WINTEM EUROC FL050 18h']);
	});

	it('a band-only level (no link level) prints at most one chart, fail-open', () => {
		const band = wintem('FRANCE', 'FL20-100', [9, 12]);
		const { picks } = select(band, [10, 13.5], { minFt: 4500, maxFt: 4500 });
		expect(picks.map((c) => c.level)).toEqual(['FL20-100']);
	});

	it('per-group notes dedupe to one line per product and zone', () => {
		const stale = [...wintem('FRANCE', 'FL020', [6]), ...wintem('FRANCE', 'FL050', [6])];
		const { notes } = select(stale, [11, 13], { minFt: 4500, maxFt: 4500 });
		expect(notes).toEqual([{ product: 'WINTEM', zone: 'FRANCE', kind: 'not-yet-published' }]);
	});
});

describe('selectTripCharts, print order', () => {
	it('TEMSI before WINTEM, FRANCE before EUROC, level then validity ascending', () => {
		const all = [
			...wintem('EUROC', 'FL050', [12]),
			...wintem('FRANCE', 'FL050', [12]),
			...wintem('FRANCE', 'FL020', [12]),
			...temsiEuroc([9, 12]),
			...temsiFrance([9, 12]),
		];
		const { picks } = select(all, [10, 13.5], { minFt: 4500, maxFt: 4500 });
		expect(picks.map(label)).toEqual([
			'TEMSI FRANCE FL20-150 9h',
			'TEMSI FRANCE FL20-150 12h',
			'TEMSI EUROC FL20-450 9h',
			'TEMSI EUROC FL20-450 12h',
			'WINTEM FRANCE FL020 12h',
			'WINTEM FRANCE FL050 12h',
			'WINTEM EUROC FL050 12h',
		]);
	});
});
