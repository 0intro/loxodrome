/* Pins the printed meteo annex's chart selection (src/lib/weather/
 * tripCharts.ts): the flight-level parse, the planned-altitude range, the
 * FRANCE / EUROC zone pick, and selectTripCharts' rules over Météo-France's
 * schedule (weather/chartSchedule.ts): covers half-way to the scheduled
 * neighbours, the latest TEMSI printed to extrapolate when the next is not
 * out yet (3 h at most), and the notes that hold the print for the pilot or
 * merely say a later chart is coming. Catalog shapes mirror the live SOFIA
 * probes (2026-07-07, 2026-09-30, 2026-10-01): TEMSI FRANCE listing the
 * current chart and the published next one, WINTEM FRANCE one composite
 * sheet FL20-100 (July: one sheet per level), WINTEM EUROC three composite
 * bands, 6-hourly. Then the download half (fetchTripCharts) over a stubbed
 * relay and an injected rasterizer. */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { SofiaChart } from '$lib/sofia/charts';
import {
	altRange,
	chartZones,
	fetchTripCharts,
	parseChartFl,
	parseChartLevels,
	selectTripCharts,
	type ChartRasterizer,
	type ChartSelection,
	type TripChartNote,
} from '$lib/weather/tripCharts';

const H = 3_600_000;
/** 2026-07-07 00:00Z; at(h) = that day at h hours UTC. */
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
	nowH?: number,
	expected?: { product: 'TEMSI' | 'WINTEM'; zone: string }[],
): ChartSelection {
	return selectTripCharts(charts, {
		windowStartMs: at(windowH[0]),
		windowEndMs: at(windowH[1]),
		altRangeFt: range,
		nowMs: nowH == null ? undefined : at(nowH),
		expected,
	});
}

const label = (c: SofiaChart): string =>
	`${c.product} ${c.zone} ${c.level ?? ''} ${(c.validAtMs! - T0) / H}h`.replace('  ', ' ');

/** A note, its unset fields defaulted. */
function noteOf(n: Partial<TripChartNote> & Pick<TripChartNote, 'product' | 'kind' | 'holds'>): TripChartNote {
	return { zone: 'FRANCE', level: null, validAtMs: null, publishAtMs: null, url: null, ...n };
}

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

describe('parseChartLevels', () => {
	it('reads one level and a band', () => {
		expect(parseChartLevels('FL050')).toEqual({ loFt: 5000, hiFt: 5000 });
		expect(parseChartLevels('FL20-100')).toEqual({ loFt: 2000, hiFt: 10000 });
		expect(parseChartLevels('FL180-300')).toEqual({ loFt: 18000, hiFt: 30000 });
		expect(parseChartLevels('SFC')).toBeNull();
		expect(parseChartLevels(null)).toBeNull();
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

	it('a lone chart covers half-way to its scheduled neighbours', () => {
		const { picks, notes } = select(temsiFrance([9]), [10, 11], null);
		expect(picks.map(label)).toEqual(['TEMSI FRANCE FL20-150 9h']);
		// 12 UTC is not listed: the flight's end will want it.
		expect(notes).toEqual([
			noteOf({ product: 'TEMSI', kind: 'later', validAtMs: at(12), publishAtMs: at(10), holds: false }),
		]);
	});

	it('the 00 UTC chart covers to 03 UTC: there is no 03 UTC TEMSI FRANCE', () => {
		const { picks, notes } = select(temsiFrance([0]), [2, 3], null, 1);
		expect(picks.map(label)).toEqual(['TEMSI FRANCE FL20-150 0h']);
		expect(notes).toEqual([]);
	});

	it('an undated group holds', () => {
		const undated = [chart({ product: 'TEMSI', level: 'FL20-150' })];
		const { picks, notes } = select(undated, [8, 13], null);
		expect(picks).toEqual([]);
		expect(notes).toEqual([noteOf({ product: 'TEMSI', kind: 'undated', holds: true })]);
	});
});

// TEMSI FRANCE as the catalog listed it at 10:47Z on 2026-10-01: the
// current chart and the published next. Covers 09 [7:30, 10:30) and 12
// [10:30, 13:30); unlisted, 15 [13:30, 16:30) out at 13:00 and 18
// [16:30, 19:30) out at 16:00.
describe('selectTripCharts, Météo-France publication times (TEMSI FRANCE, 2 h lead)', () => {
	const listed = temsiFrance([9, 12]);
	const url12 = listed[1].url;

	it('a flight inside the published charts prints at once', () => {
		const { picks, notes } = select(listed, [11.25, 12.75], null, 10.8);
		expect(picks.map(label)).toEqual(['TEMSI FRANCE FL20-150 12h']);
		expect(notes).toEqual([]);
	});

	it('a start the next chart will cover prints the latest one to extrapolate, without holding', () => {
		const { picks, notes } = select(listed, [13 + 40 / 60, 15], null, 10.8);
		expect(picks.map(label)).toEqual(['TEMSI FRANCE FL20-150 12h']);
		expect(notes).toEqual([
			noteOf({
				product: 'TEMSI',
				kind: 'extrapolated',
				validAtMs: at(15),
				publishAtMs: at(13),
				url: url12,
				holds: false,
			}),
		]);
	});

	it('the same flight once the 15 UTC chart is overdue holds', () => {
		const { picks, notes } = select(listed, [13 + 40 / 60, 15], null, 13 + 35 / 60);
		expect(picks.map(label)).toEqual(['TEMSI FRANCE FL20-150 12h']);
		expect(notes.map((n) => [n.kind, n.holds])).toEqual([
			['extrapolated', false],
			['missing', true],
		]);
	});

	it('a start more than 3 h past the latest chart holds, naming when the needed one is out', () => {
		const { picks, notes } = select(listed, [16 + 10 / 60, 17], null, 10.8);
		expect(picks).toEqual([]);
		expect(notes).toEqual([
			noteOf({ product: 'TEMSI', kind: 'not-yet-published', validAtMs: at(15), publishAtMs: at(13), holds: true }),
			noteOf({ product: 'TEMSI', kind: 'later', validAtMs: at(18), publishAtMs: at(16), holds: false }),
		]);
	});

	it('once the 15 UTC chart is out, only the end of the flight waits', () => {
		const { picks, notes } = select(temsiFrance([9, 12, 15]), [16 + 10 / 60, 17], null, 13 + 10 / 60);
		expect(picks.map(label)).toEqual(['TEMSI FRANCE FL20-150 15h']);
		expect(notes).toEqual([
			noteOf({ product: 'TEMSI', kind: 'later', validAtMs: at(18), publishAtMs: at(16), holds: false }),
		]);
	});

	it('a chart missing in the middle holds once its publication is overdue', () => {
		const { picks, notes } = select(temsiFrance([9, 15]), [11.25, 15], null, 11);
		expect(picks.map(label)).toEqual(['TEMSI FRANCE FL20-150 9h', 'TEMSI FRANCE FL20-150 15h']);
		expect(notes.map((n) => [n.kind, n.holds, (n.validAtMs! - T0) / H])).toEqual([
			['extrapolated', false, 12],
			['missing', true, 12],
		]);
	});
});

describe('selectTripCharts, the night (no 03 UTC TEMSI FRANCE)', () => {
	const listed = temsiFrance([0]);

	it('a flight to 04 UTC wants the 06 UTC chart for its end', () => {
		const { picks, notes } = select(listed, [2, 4], null, 1);
		expect(picks.map(label)).toEqual(['TEMSI FRANCE FL20-150 0h']);
		expect(notes).toEqual([
			noteOf({ product: 'TEMSI', kind: 'later', validAtMs: at(6), publishAtMs: at(4), holds: false }),
		]);
	});

	it('a start past 03 UTC, more than 3 h after 00 UTC, holds for the 06 UTC chart', () => {
		const { picks, notes } = select(listed, [3.5, 4.5], null, 1);
		expect(picks).toEqual([]);
		expect(notes).toEqual([
			noteOf({ product: 'TEMSI', kind: 'not-yet-published', validAtMs: at(6), publishAtMs: at(4), holds: true }),
		]);
	});
});

describe('selectTripCharts, TEMSI EUROC (4 h lead)', () => {
	const listed = temsiEuroc([9, 12]);

	it('extrapolates while the 15 UTC chart is not due, holds once it is overdue', () => {
		const early = select(listed, [13 + 40 / 60, 15], null, 10.8);
		expect(early.notes.map((n) => [n.zone, n.kind, n.holds])).toEqual([['EUROC', 'extrapolated', false]]);
		const late = select(listed, [13 + 40 / 60, 15], null, 11 + 40 / 60);
		expect(late.notes.map((n) => [n.kind, n.holds, (n.publishAtMs! - T0) / H])).toEqual([
			['extrapolated', false, 11],
			['missing', true, 11],
		]);
	});
});

describe('selectTripCharts, a TEMSI at the flight’s start (what the DWD forecasts read)', () => {
	const listed = temsiFrance([9, 12]);

	it('is there when the chart covering the start is listed', () => {
		expect(select(listed, [11.25, 12.75], null, 10.8).temsiAtStart).toBe(true);
	});

	it('is there when the latest chart stands in for it, extrapolated', () => {
		expect(select(listed, [13 + 40 / 60, 15], null, 10.8).temsiAtStart).toBe(true);
	});

	it('is not there when the chart the start needs is not out yet', () => {
		expect(select(listed, [16 + 10 / 60, 17], null, 10.8).temsiAtStart).toBe(false);
	});

	it('is not there with a WINTEM alone, nor for a flight already flown', () => {
		const range = { minFt: 2000, maxFt: 4500 };
		expect(select(wintem('FRANCE', 'FL20-100', [12]), [11.25, 12.75], range, 10.8).temsiAtStart).toBe(false);
		expect(select(listed, [8, 10], null, 12).temsiAtStart).toBe(false);
	});

	it('reads an unscheduled zone off the catalog’s own spacing', () => {
		const nat = [chart({ product: 'TEMSI', zone: 'NAT', validAtMs: at(12) })];
		expect(select(nat, [11, 12], null, 9).temsiAtStart).toBe(true);
		expect(select(nat, [14, 15], null, 9).temsiAtStart).toBe(false);
	});
});

describe('selectTripCharts, the flight in time', () => {
	it('a flight already flown picks nothing, and says it once rather than per product', () => {
		const { picks, notes, past } = select(temsiFrance([9, 12]), [8, 10], null, 12, [
			{ product: 'TEMSI', zone: 'FRANCE' },
			{ product: 'WINTEM', zone: 'FRANCE' },
		]);
		expect(picks).toEqual([]);
		expect(notes).toEqual([]);
		expect(past).toBe(true);
	});

	it('a flight still ahead is not past', () => {
		expect(select(temsiFrance([9, 12]), [11, 12], null, 10.8).past).toBe(false);
	});

	it('a flight under way needs charts for what is left of it only', () => {
		const { picks, notes } = select(temsiFrance([9, 12]), [5, 11], null, 10);
		expect(picks.map(label)).toEqual(['TEMSI FRANCE FL20-150 9h', 'TEMSI FRANCE FL20-150 12h']);
		expect(notes).toEqual([]);
	});

	it('a catalog listing nothing for a product holds', () => {
		const { notes } = select(temsiFrance([9]), [9, 10], { minFt: 4500, maxFt: 4500 }, 8.5, [
			{ product: 'TEMSI', zone: 'FRANCE' },
			{ product: 'WINTEM', zone: 'FRANCE' },
		]);
		expect(notes).toEqual([noteOf({ product: 'WINTEM', kind: 'none', holds: true })]);
	});
});

describe('selectTripCharts, WINTEM levels', () => {
	// July 2026: one sheet per level.
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
		// 21:00 (half-way to 00 UTC), so a 19:00-21:00 evening window picks it.
		const euroc = wintem('EUROC', 'FL050', [6, 12, 18]);
		const { picks } = select(euroc, [19, 21], { minFt: 4500, maxFt: 4500 });
		expect(picks.map(label)).toEqual(['WINTEM EUROC FL050 18h']);
	});

	it('a band-only level (no link level) prints at most one chart, fail-open', () => {
		const band = wintem('FRANCE', 'FL20-100', [9, 12]);
		const { picks } = select(band, [10, 13.5], { minFt: 4500, maxFt: 4500 });
		expect(picks.map((c) => c.level)).toEqual(['FL20-100']);
	});

	it('sheets short of the same chart are one line, naming no sheet', () => {
		const stale = [...wintem('FRANCE', 'FL020', [6]), ...wintem('FRANCE', 'FL050', [6])];
		const { notes } = select(stale, [11, 13], { minFt: 4500, maxFt: 4500 });
		expect(notes).toEqual([
			noteOf({ product: 'WINTEM', kind: 'not-yet-published', validAtMs: at(12), holds: true }),
		]);
	});
});

// October 2026: one composite sheet per band, named by the band.
describe('selectTripCharts, WINTEM composite sheets', () => {
	const france = wintem('FRANCE', 'FL20-100', [9, 12, 15]);
	const euroc = [
		...wintem('EUROC', 'FL50-100', [12, 18]),
		...wintem('EUROC', 'FL180-300', [12, 18]),
		...wintem('EUROC', 'FL340-390', [12, 18]),
	];
	const sheets = (ft: number, maxFt = ft): string[] =>
		select([...france, ...euroc], [11, 13], { minFt: ft, maxFt }).picks.map(
			(c) => `${c.zone} ${c.level}`,
		);

	it('prints the band holding the cruise, and only it', () => {
		expect(sheets(4500)).toEqual(['FRANCE FL20-100', 'EUROC FL50-100']);
		expect(sheets(8000)).toEqual(['FRANCE FL20-100', 'EUROC FL50-100']);
	});

	it('brackets a cruise between two bands with both', () => {
		expect(sheets(11500)).toEqual(['FRANCE FL20-100', 'EUROC FL50-100', 'EUROC FL180-300']);
	});

	it('prints the nearest band below a cruise above every band it has', () => {
		expect(sheets(25000)).toEqual(['FRANCE FL20-100', 'EUROC FL180-300']);
	});

	it('a climb inside one band prints that band', () => {
		expect(sheets(2000, 9500)).toEqual(['FRANCE FL20-100', 'EUROC FL50-100']);
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

// The two zones' catalogues arrive concatenated, and a chart both list (or one
// listed twice) was picked twice: printed twice, and the dossier keys its
// chart sheets on the link, where Svelte throws on a repeat.
describe('a chart listed twice', () => {
	it('is picked once', () => {
		const [c] = temsiFrance([12]);
		const { picks } = select([c, { ...c }], [11, 13], null);
		expect(picks.map((p) => p.url)).toEqual([c.url]);
	});

	it('stays in every zone that lists it, where it bounds its neighbours', () => {
		// EUROC lists 06Z, 18Z and the 12Z chart FRANCE lists too. Dropped
		// from EUROC before the zones were grouped, the 06Z and 18Z covers
		// met at noon and both were printed for a window only 12Z covers.
		const fr = temsiFrance([12]);
		const eur = temsiEuroc([6, 18]);
		const shared = { ...fr[0], zone: 'EUROC' };
		const { picks } = select([...fr, ...eur, shared], [11.5, 12.5], null);
		expect(picks.map((p) => p.url)).toEqual([fr[0].url]);
	});
});

// The download half, over a stubbed relay and an injected rasterizer.
describe('fetchTripCharts', () => {
	const PDF = (tag: string): string => `%PDF-1.4 ${tag}`;
	const rendered: string[] = [];
	const rasterizer = (): Promise<ChartRasterizer> =>
		Promise.resolve({
			render(data: ArrayBuffer) {
				rendered.push(new TextDecoder().decode(data));
				return Promise.resolve({ pngDataUrl: 'data:image/png;base64,', wPx: 2200, hPx: 1555 });
			},
			destroy() {},
		});

	beforeEach(() => {
		// setImmediate stays real: the digest resolves on a worker thread,
		// and settle() yields to it between two advances of the clock.
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		vi.setSystemTime(at(10.8));
		rendered.length = 0;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	/** Advance the fake clock until the run settles: the digest resolves off
	 *  that clock, so one advance can end before the next pause is set. */
	async function settle<T>(p: Promise<T>): Promise<T> {
		let done = false;
		void p.finally(() => (done = true));
		for (let i = 0; i < 2000 && !done; i++) {
			await vi.advanceTimersByTimeAsync(500);
			await new Promise((r) => setImmediate(r));
		}
		return p;
	}

	function run(charts: SofiaChart[], windowH: [number, number]) {
		return fetchTripCharts({
			proxyBase: 'https://proxy.test',
			catalogs: [{ zone: 'FRANCE', product: 'TEMSI', charts, failure: null }],
			windowStartMs: at(windowH[0]),
			windowEndMs: at(windowH[1]),
			altRangeFt: null,
			nowMs: at(10.8),
			rasterizer,
		});
	}

	it('asks a failing relay once more, then renders', async () => {
		let n = 0;
		const fetchMock = vi.fn(() =>
			Promise.resolve(
				++n === 1 ? new Response('upstream error', { status: 502 }) : new Response(PDF('12')),
			),
		);
		vi.stubGlobal('fetch', fetchMock);
		const doc = await settle(run(temsiFrance([12]), [11, 12]));
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(doc.entries).toHaveLength(1);
		expect(doc.failed).toEqual([]);
	});

	it('says why a chart failed, and never asks again for a spent link', async () => {
		const fetchMock = vi.fn(() => Promise.resolve(new Response('<html>expirée</html>', { status: 200 })));
		vi.stubGlobal('fetch', fetchMock);
		const doc = await settle(run(temsiFrance([12]), [11, 12]));
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(doc.failed.map((f) => f.failure.code)).toEqual(['expired']);
	});

	it('prints one sheet once, whatever links serve it', async () => {
		vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(PDF('same')))));
		// 12 and 15 UTC both cover the flight, and both links serve one sheet.
		const doc = await settle(run(temsiFrance([12, 15]), [11, 14]));
		expect(doc.entries).toHaveLength(1);
		expect(rendered).toEqual(['%PDF-1.4 same']);
	});

	it('downloads nothing for a flight already flown, and the doc says when it was', async () => {
		const fetchMock = vi.fn(() => Promise.resolve(new Response(PDF('9'))));
		vi.stubGlobal('fetch', fetchMock);
		const doc = await settle(run(temsiFrance([9]), [8, 10]));
		expect(fetchMock).not.toHaveBeenCalled();
		expect(doc.past).toEqual({ startMs: at(8), dayOnly: false });
		expect(doc.notes).toEqual([]);
		const ahead = await settle(run(temsiFrance([12]), [11, 12]));
		expect(ahead.past).toBeNull();
	});

	it('marks the extrapolated sheet with the chart it stands in for', async () => {
		vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(PDF('12')))));
		const doc = await settle(run(temsiFrance([9, 12]), [13 + 40 / 60, 15]));
		expect(doc.entries.map((e) => e.extrapolated)).toEqual([
			{ nextValidAtMs: at(15), publishAtMs: at(13) },
		]);
	});
});
