/* Pins the DWD front charts (src/lib/weather/frontCharts.ts,
 * docs/front-charts.md) on what was observed on 2026-10-02:
 *   - the analyses' names on DWD's open-data server, validity and production
 *     stamp in the name (the 06 UTC chart produced at 07:49:52);
 *   - the six forecast files' Last-Modified (v36 01/10 23:59, 036 03:52,
 *     048 / 060 05:01, 084 / 108 05:47) and the validity each chart's own
 *     legend prints, read by OCR: every file is the 00 UTC run plus its
 *     lead, v36 being the PREVIOUS day's run (today 12 UTC);
 * then the selection (the situation, the charts within 6 h of the flight,
 * the notes that hold the print), the PNG header read, and the fetch half
 * over a stubbed network. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	DWD_ANALYSIS_BASE,
	DWD_FORECAST_STEPS,
	analysesFromNames,
	chartUrl,
	fetchFrontCharts,
	fetchFrontIndex,
	forecastChart,
	forecastStep,
	forecastValidity,
	frontChartToken,
	frontChartsListed,
	keepAfterDownload,
	parseAnalysisName,
	pngSize,
	runToken,
	selectFrontCharts,
	type DwdForecastStep,
	type FrontChart,
	type FrontChartsIndex,
} from '$lib/weather/frontCharts';

const at = (d: number, h: number, m = 0, s = 0): number => Date.UTC(2026, 9, d, h, m, s);

/** An analysis name as the listing spells it. */
function analysisName(produced: string, valid: string, rendering = 'WV12'): string {
	return `Z__C_EDZW_${produced}_tka01%2Cana_bwkman_dwdna_O_000000_000000_${valid}_${rendering}.png`;
}

function step(id: string): DwdForecastStep {
	const s = forecastStep(id);
	if (!s) {
		throw new Error(id);
	}
	return s;
}

function analysis(d: number, h: number, producedAfterMin = 100): FrontChart {
	const validAtMs = at(d, h);
	return { kind: 'analysis', validAtMs, issuedAtMs: validAtMs + producedAfterMin * 60_000, leadH: null, ref: `ana-${d}-${h}` };
}

function forecast(id: string, lastModifiedMs: number): FrontChart {
	const c = forecastChart(step(id), lastModifiedMs);
	if (!c) {
		throw new Error(`${id} undated`);
	}
	return c;
}

function index(partial: Partial<FrontChartsIndex>): FrontChartsIndex {
	return {
		fetchedAtMs: 0,
		analyses: [],
		forecasts: [],
		undated: [],
		analysisFailure: null,
		forecastFailure: null,
		...partial,
	};
}

/** The forecast files as they stood on 2026-10-02 from 05:47 on. */
const FORECASTS_02 = [
	forecast('v36', at(1, 23, 59)),
	forecast('036', at(2, 3, 52, 2)),
	forecast('048', at(2, 5, 1, 6)),
	forecast('060', at(2, 5, 1, 14)),
	forecast('084', at(2, 5, 47, 36)),
	forecast('108', at(2, 5, 47, 44)),
];

const label = (c: FrontChart): string =>
	`${c.kind === 'analysis' ? 'A' : `F${c.ref}`} ${new Date(c.validAtMs).toISOString().slice(5, 13)}`;

describe('the analyses, named by the open-data server', () => {
	it('reads the validity and the production stamp off the name', () => {
		expect(parseAnalysisName(analysisName('20261002074952', '202610020600'))).toEqual({
			validAtMs: at(2, 6),
			producedAtMs: at(2, 7, 49, 52),
		});
	});

	it('takes the colour North Atlantic-Europe chart only, spelled as listed', () => {
		const good = analysisName('20261002074952', '202610020600');
		for (const bad of [
			analysisName('20261002074952', '202610020600', 'WV12SW'),
			good.replace('dwdna', 'dwdc'),
			'Z__C_EDZW_LATEST_tka01%2Cana_bwkman_dwdna_O_000000_000000_LATEST_WV12.png',
			'Z__C_EDZW_LATEST_tka01%2Cana_bwkman_dwdna_O_000000_000000_202610020600_WV12SW.png_LATEST_WV12SW.png',
			good.replace('%2C', ','),
			// Produced before its own validity, off a synoptic hour, not a date.
			analysisName('20261002050000', '202610020600'),
			analysisName('20261002074952', '202610020300'),
			analysisName('20261302074952', '202613020600'),
		]) {
			expect(parseAnalysisName(bad), bad).toBeNull();
		}
	});

	it('keeps one chart per validity, the newer production, ascending', () => {
		const list = analysesFromNames([
			analysisName('20261002074952', '202610020600'),
			analysisName('20261002014431', '202610020000'),
			analysisName('20261002080500', '202610020600'), // produced again later
			analysisName('20261001191239', '202610011800', 'WV12SW'),
			'junk',
		]);
		expect(list.map((c) => [c.validAtMs, c.issuedAtMs])).toEqual([
			[at(2, 0), at(2, 1, 44, 31)],
			[at(2, 6), at(2, 8, 5)],
		]);
		expect(list.every((c) => c.kind === 'analysis' && c.leadH === null)).toBe(true);
	});
});

describe('the forecast files, dated off their Last-Modified', () => {
	it('dates every file as its own legend reads (OCR, 2026-10-02)', () => {
		const v = (id: string, lm: number) => forecastValidity(step(id), lm);
		// [ICON 2026-10-01 00UTC+36h], VT 12 UTC Fr 02 Okt
		expect(v('v36', at(1, 23, 59))).toEqual({ runMs: at(1, 0), validAtMs: at(2, 12) });
		// [ICON 2026-10-02 00UTC+36h], VT 12 UTC Sa 03 Okt, and so on.
		expect(v('036', at(2, 3, 52, 2))).toEqual({ runMs: at(2, 0), validAtMs: at(3, 12) });
		expect(v('048', at(2, 5, 1, 6))).toEqual({ runMs: at(2, 0), validAtMs: at(4, 0) });
		expect(v('060', at(2, 5, 1, 14))).toEqual({ runMs: at(2, 0), validAtMs: at(4, 12) });
		expect(v('084', at(2, 5, 47, 36))).toEqual({ runMs: at(2, 0), validAtMs: at(5, 12) });
		expect(v('108', at(2, 5, 47, 44))).toEqual({ runMs: at(2, 0), validAtMs: at(6, 12) });
	});

	it('dates v36 written just past midnight to the run before', () => {
		expect(forecastValidity(step('v36'), at(2, 0, 30))).toEqual({ runMs: at(1, 0), validAtMs: at(2, 12) });
	});

	it('dates a file not yet replaced by its own older run', () => {
		// 036 still holds yesterday's chart until today's lands at ~03:52.
		expect(forecastValidity(step('036'), at(1, 3, 52))).toEqual({ runMs: at(1, 0), validAtMs: at(2, 12) });
	});

	it('leaves undated a file written off its schedule', () => {
		const v = (id: string, lm: number) => forecastValidity(step(id), lm);
		expect(v('036', at(2, 2, 0))).toBeNull(); // before any run could have been drawn
		expect(v('036', at(2, 16, 0))).toBeNull(); // the afternoon: not a 00 UTC drawing
		expect(v('048', at(2, 19, 30))).toBeNull(); // DWD's page: maybe the 12 UTC run's
		expect(v('v36', at(2, 3, 30))).toBeNull();
		expect(v('v36', at(2, 10, 0))).toBeNull();
		expect(v('036', Number.NaN)).toBeNull();
	});

	it('names every step DWD serves, each on the 00 UTC run', () => {
		expect(DWD_FORECAST_STEPS.map((s) => s.id)).toEqual(['v36', '036', '048', '060', '084', '108']);
	});
});

describe('the selection for a flight', () => {
	it('prints the situation and tomorrow noon for a flight planned the evening before', () => {
		// Printed at 20:00Z: the 18Z analysis is out (19:12).
		const sel = selectFrontCharts(
			index({
				analyses: [analysis(2, 0), analysis(2, 6), analysis(2, 12), analysis(2, 18, 72)],
				forecasts: FORECASTS_02,
			}),
			{ windowStartMs: at(3, 8), windowEndMs: at(3, 11), nowMs: at(2, 20) },
		);
		expect(sel.picks.map(label)).toEqual(['A 10-02T18', 'F036 10-03T12']);
		expect(sel.notes).toEqual([]);
	});

	it('prints the morning analysis and today noon for a flight later the same day', () => {
		// Printed at 08:00Z: the 06Z analysis is out (07:49), v36 is today noon.
		const sel = selectFrontCharts(
			index({ analyses: [analysis(2, 0), analysis(2, 6)], forecasts: FORECASTS_02 }),
			{ windowStartMs: at(2, 10), windowEndMs: at(2, 13), nowMs: at(2, 8) },
		);
		// The situation is itself a chart for the flight: printed once.
		expect(sel.picks.map(label)).toEqual(['A 10-02T06', 'Fv36 10-02T12']);
	});

	it('says, and holds, a flight past the last forecast DWD has drawn', () => {
		const sel = selectFrontCharts(index({ analyses: [analysis(2, 6)], forecasts: FORECASTS_02 }), {
			windowStartMs: at(8, 10),
			windowEndMs: at(8, 12),
			nowMs: at(2, 8),
		});
		expect(sel.picks.map(label)).toEqual(['A 10-02T06']);
		expect(sel.notes).toEqual([
			{ kind: 'beyond', validAtMs: at(6, 12), count: null, failure: null, holds: true },
		]);
	});

	it('names the nearest analysis, never a forecast horizon, when no forecast is dated', () => {
		// Every forecast file undated (DWD off its schedule): the newest
		// analysis is only the nearest chart, not where DWD's forecasts end.
		const sel = selectFrontCharts(
			index({ analyses: [analysis(2, 6)], undated: ['v36', '036', '048', '060', '084', '108'] }),
			{ windowStartMs: at(4, 10), windowEndMs: at(4, 12), nowMs: at(2, 8) },
		);
		expect(sel.picks.map(label)).toEqual(['A 10-02T06']);
		expect(sel.notes).toEqual([
			{ kind: 'undated', validAtMs: null, count: 6, failure: null, holds: false },
			{ kind: 'none-near', validAtMs: at(2, 6), count: null, failure: null, holds: true },
		]);
	});

	it('says, and holds, a flight between two charts too far either side', () => {
		// An evening flight printed at 15:00Z: the 12Z analysis 8 h before,
		// tomorrow noon 13 h after, no 00Z chart drawn.
		const sel = selectFrontCharts(
			index({ analyses: [analysis(2, 6), analysis(2, 12)], forecasts: FORECASTS_02 }),
			{ windowStartMs: at(2, 20), windowEndMs: at(2, 23), nowMs: at(2, 15) },
		);
		expect(sel.picks.map(label)).toEqual(['A 10-02T12']);
		expect(sel.notes).toEqual([
			{ kind: 'none-near', validAtMs: at(2, 12), count: null, failure: null, holds: true },
		]);
	});

	it('counts a chart exactly 6 h from the flight as near it', () => {
		// 05/10 12Z (084) is 6 h before the start; the next, 06/10 12Z, 17 h after.
		const sel = selectFrontCharts(index({ forecasts: FORECASTS_02 }), {
			windowStartMs: at(5, 18),
			windowEndMs: at(5, 19),
			nowMs: at(2, 20),
		});
		expect(sel.picks.map(label)).toEqual(['F084 10-05T12']);
		expect(sel.notes).toEqual([]);
	});

	it('prints one chart where v36 and the 036 not yet replaced share a validity', () => {
		// 02:00Z: v36 (written 01/10 23:59) and 036 (still 01/10's) are both
		// today noon, off the same run.
		const sel = selectFrontCharts(
			index({
				analyses: [analysis(2, 0)],
				forecasts: [forecast('v36', at(1, 23, 59)), forecast('036', at(1, 3, 52))],
			}),
			{ windowStartMs: at(2, 11), windowEndMs: at(2, 13), nowMs: at(2, 2) },
		);
		expect(sel.picks.map(label)).toEqual(['A 10-02T00', 'Fv36 10-02T12']);
	});

	it('prints the analysis rather than a forecast of the same hour', () => {
		const sel = selectFrontCharts(index({ analyses: [analysis(2, 12)], forecasts: FORECASTS_02 }), {
			windowStartMs: at(2, 11),
			windowEndMs: at(2, 13),
			nowMs: at(2, 15),
		});
		expect(sel.picks.map(label)).toEqual(['A 10-02T12']);
	});

	it('keeps the two charts nearest the middle of a long flight, beside the situation', () => {
		const sel = selectFrontCharts(index({ analyses: [analysis(2, 18)], forecasts: FORECASTS_02 }), {
			windowStartMs: at(3, 0),
			windowEndMs: at(4, 12),
			nowMs: at(2, 20),
		});
		// 03/10 12Z and 04/10 00Z tie at 6 h from the middle; 04/10 12Z is 18 h.
		expect(sel.picks.map(label)).toEqual(['A 10-02T18', 'F036 10-03T12', 'F048 10-04T00']);
	});

	it('says which half failed, holding, and prints what the other has', () => {
		const failure = { code: 'upstream' as const, detail: 'DWD analysis listing failed: HTTP 502' };
		const sel = selectFrontCharts(index({ forecasts: FORECASTS_02, analysisFailure: failure }), {
			windowStartMs: at(3, 9),
			windowEndMs: at(3, 12),
			nowMs: at(2, 20),
		});
		expect(sel.picks.map(label)).toEqual(['F036 10-03T12']);
		expect(sel.notes).toEqual([
			{ kind: 'analyses-unavailable', validAtMs: null, count: null, failure, holds: true },
		]);
	});

	it('prints the analysis alone while a TEMSI serves the flight’s start', () => {
		// Printed at 08:00Z for a flight at 10Z, today’s TEMSI being out: the
		// forecasts are no candidate, v36 at today noon included.
		const sel = selectFrontCharts(
			index({ analyses: [analysis(2, 0), analysis(2, 6)], forecasts: FORECASTS_02 }),
			{ windowStartMs: at(2, 10), windowEndMs: at(2, 13), nowMs: at(2, 8), forecasts: false },
		);
		expect(sel.picks.map(label)).toEqual(['A 10-02T06']);
		expect(sel.notes).toEqual([]);
	});

	it('says nothing of the forecasts a TEMSI stands for: no chart near, failed, or undated', () => {
		// An evening flight printed at 17:00Z: no DWD chart within 6 h, which
		// would hold the print, and the forecasts’ own failures, all silent.
		const failure = { code: 'unreachable' as const, detail: 'DWD forecast v36 unreachable: Failed to fetch' };
		const opts = { windowStartMs: at(2, 20), windowEndMs: at(2, 21), nowMs: at(2, 17) };
		const idx = index({ analyses: [analysis(2, 6), analysis(2, 12)], forecasts: FORECASTS_02 });
		expect(selectFrontCharts(idx, opts).notes.map((n) => n.kind)).toEqual(['none-near']);
		const sel = selectFrontCharts(idx, { ...opts, forecasts: false });
		expect(sel.picks.map(label)).toEqual(['A 10-02T12']);
		expect(sel.notes).toEqual([]);
		const down = index({ analyses: [analysis(2, 12)], undated: ['048'], forecastFailure: failure });
		expect(selectFrontCharts(down, { ...opts, forecasts: false }).notes).toEqual([]);
	});

	it('still says, and holds, the analyses unavailable while a TEMSI serves the start', () => {
		const failure = { code: 'upstream' as const, detail: 'DWD analysis listing failed: HTTP 502' };
		const sel = selectFrontCharts(index({ forecasts: FORECASTS_02, analysisFailure: failure }), {
			windowStartMs: at(2, 10),
			windowEndMs: at(2, 13),
			nowMs: at(2, 8),
			forecasts: false,
		});
		expect(sel.picks).toEqual([]);
		expect(sel.notes.map((n) => [n.kind, n.holds])).toEqual([['analyses-unavailable', true]]);
	});

	it('says, without holding, a forecast left out undated and an old situation', () => {
		const sel = selectFrontCharts(
			index({ analyses: [analysis(1, 18)], forecasts: FORECASTS_02.slice(1), undated: ['v36'] }),
			{ windowStartMs: at(3, 9), windowEndMs: at(3, 12), nowMs: at(2, 12) },
		);
		expect(sel.notes.map((n) => [n.kind, n.holds])).toEqual([
			['undated', false],
			['situation-old', false],
		]);
	});
});

describe('a chart re-dated at download', () => {
	it('is dropped once out of the flight’s reach or onto another pick, the situation always kept', () => {
		const situation = analysis(2, 6);
		const keep = keepAfterDownload(
			[
				{ chart: situation, wasSituation: true },
				{ chart: forecast('036', at(2, 3, 52)), wasSituation: false }, // 03/10 12Z, near
				{ chart: forecast('048', at(2, 5, 1)), wasSituation: false }, // 04/10 00Z, out of reach
				{ chart: { ...forecast('v36', at(1, 23, 59)), validAtMs: at(2, 6) }, wasSituation: false }, // onto the situation
			],
			at(3, 9),
			at(3, 12),
		);
		expect(keep).toEqual([true, true, false, false]);
	});
});

describe('the PNG header', () => {
	const head = new Uint8Array([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x11, 0x25, 0,
		0, 0x0c, 0x2a, 8, 2,
	]);

	it('reads the pixel size without decoding', () => {
		// The 4389 x 3114 analysis.
		expect(pngSize(head)).toEqual({ w: 4389, h: 3114 });
	});

	it('refuses what is not a PNG', () => {
		expect(pngSize(new TextEncoder().encode('<html>error page, under a 200</html>'))).toBeNull();
		expect(pngSize(head.slice(0, 20))).toBeNull();
		const noIhdr = head.slice();
		noIhdr[12] = 0x58;
		expect(pngSize(noIhdr)).toBeNull();
	});
});

describe('the labels and links', () => {
	it('spells the model run and the token invariantly', () => {
		const c = forecast('036', at(2, 3, 52, 2));
		expect(runToken(c)).toBe('ICON 2026-10-02 00Z +36 h');
		expect(runToken(analysis(2, 6))).toBeNull();
		expect(frontChartToken(c)).toBe('DWD 2026-10-03 12:00Z');
	});

	it('links a chart at DWD itself', () => {
		const name = analysisName('20261002074952', '202610020600');
		const [a] = analysesFromNames([name]);
		expect(chartUrl(a)).toBe(DWD_ANALYSIS_BASE + name);
		expect(chartUrl(forecast('036', at(2, 3, 52)))).toBe(
			'https://www.dwd.de/DWD/wetter/wv_spez/hobbymet/wetterkarten/ico_tkboden_na_036.png',
		);
	});

	it('lists the newest analysis and the forecasts, the analysis where they meet', () => {
		const list = frontChartsListed(index({ analyses: [analysis(2, 6), analysis(2, 12)], forecasts: FORECASTS_02 }));
		expect(list.map(label)).toEqual([
			'A 10-02T12',
			'F036 10-03T12',
			'F048 10-04T00',
			'F060 10-04T12',
			'F084 10-05T12',
			'F108 10-06T12',
		]);
	});
});

describe('the fetch half', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	const PROXY = 'https://proxy.example';
	const NAME = analysisName('20261002074952', '202610020600');
	/** A PNG header and a few bytes: 64 x 32. */
	const PNG = new Uint8Array([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 64, 0, 0, 0,
		32, 8, 2, 0, 0, 0, 1, 2, 3,
	]);
	const LM: Record<string, string> = {
		v36: new Date(at(1, 23, 59)).toUTCString(),
		'036': new Date(at(2, 3, 52, 2)).toUTCString(),
		'048': new Date(at(2, 5, 1, 6)).toUTCString(),
		'060': new Date(at(2, 5, 1, 14)).toUTCString(),
		'084': new Date(at(2, 5, 47, 36)).toUTCString(),
		'108': new Date(at(2, 5, 47, 44)).toUTCString(),
	};
	const stepOf = (url: string): string | null => /ico_tkboden_na_(\w+)\.png$/.exec(url)?.[1] ?? null;

	it('lists the analyses through the relay and dates the forecasts at www.dwd.de', async () => {
		const calls: { url: string; method: string }[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn((url: string, init: RequestInit = {}) => {
				calls.push({ url, method: init.method ?? 'GET' });
				if (url === `${PROXY}/dwd/charts/analysis`) {
					return Promise.resolve(Response.json({ names: [NAME] }));
				}
				const id = stepOf(url);
				if (id === '108') {
					return Promise.resolve(new Response(null, { status: 404 }));
				}
				return Promise.resolve(new Response(null, { headers: { 'last-modified': LM[id ?? ''] ?? 'x' } }));
			}),
		);
		const idx = await fetchFrontIndex(PROXY);
		expect(idx.analysisFailure).toBeNull();
		expect(idx.forecastFailure).toBeNull();
		expect(idx.analyses.map((c) => c.validAtMs)).toEqual([at(2, 6)]);
		// 108 missing is skipped, not the whole half.
		expect(idx.forecasts.map((c) => c.ref)).toEqual(['v36', '036', '048', '060', '084']);
		expect(calls.filter((c) => c.method === 'HEAD')).toHaveLength(6);
	});

	it('tells a relay without the route, a busy one and a dead network apart', async () => {
		for (const [answer, code] of [
			[() => Promise.resolve(new Response('not found', { status: 404 })), 'notDeployed'],
			[() => Promise.resolve(new Response('slow down', { status: 429 })), 'busy'],
			[() => Promise.resolve(new Response('upstream error', { status: 502 })), 'upstream'],
			[() => Promise.reject(new TypeError('Failed to fetch')), 'unreachable'],
		] as const) {
			vi.stubGlobal('fetch', vi.fn(answer));
			const idx = await fetchFrontIndex(PROXY);
			expect(idx.analysisFailure?.code).toBe(code);
			expect(idx.forecastFailure).not.toBeNull();
		}
	});

	it('says a listing that names no analysis, holding, rather than printing without one', async () => {
		for (const names of [[], ['Z__C_EDZW_LATEST_tka01%2Cana_bwkman_dwdna_O_000000_000000_LATEST_WV12.png']]) {
			vi.stubGlobal(
				'fetch',
				vi.fn((url: string) =>
					url === `${PROXY}/dwd/charts/analysis`
						? Promise.resolve(Response.json({ names }))
						: Promise.resolve(new Response(null, { headers: { 'last-modified': LM[stepOf(url) ?? ''] ?? 'x' } })),
				),
			);
			const idx = await fetchFrontIndex(PROXY);
			expect(idx.analyses).toEqual([]);
			expect(idx.analysisFailure?.code).toBe('empty');
			const sel = selectFrontCharts(idx, { windowStartMs: at(3, 10), windowEndMs: at(3, 12), nowMs: at(2, 8) });
			expect(sel.notes.filter((n) => n.holds).map((n) => n.kind)).toEqual(['analyses-unavailable']);
			// The forecasts still print what they have.
			expect(sel.picks.map(label)).toEqual(['F036 10-03T12']);
		}
	});

	it('downloads the picks, the analysis by its name verbatim, and re-dates a forecast', async () => {
		const urls: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn((url: string) => {
				urls.push(url);
				const id = stepOf(url);
				// A new run landed on 036 between the index and the download:
				// its validity moves to 04/10 12Z, out of the flight's reach.
				const lm = id === '036' ? new Date(at(3, 3, 52)).toUTCString() : '';
				return Promise.resolve(new Response(PNG, { headers: { 'last-modified': lm } }));
			}),
		);
		const idx = index({ analyses: analysesFromNames([NAME]), forecasts: FORECASTS_02 });
		const doc = await fetchFrontCharts({
			proxyBase: PROXY,
			index: idx,
			windowStartMs: at(3, 9),
			windowEndMs: at(3, 12),
			nowMs: at(2, 10),
		});
		// The comma stays %2C: encoded twice, the relay would refuse the name.
		expect(urls[0]).toBe(`${PROXY}/dwd/charts/analysis/${NAME}`);
		expect(urls[1]).toMatch(/ico_tkboden_na_036\.png$/);
		// The situation prints; the re-dated forecast left the flight's reach.
		expect(doc.entries.map((e) => e.chart.kind)).toEqual(['analysis']);
		expect(doc.entries[0].dataUrl.startsWith('data:image/png;base64,')).toBe(true);
		expect([doc.entries[0].wPx, doc.entries[0].hPx]).toEqual([64, 32]);
		expect(doc.notes.map((n) => n.kind)).toEqual(['none-near']);
		expect(doc.failed).toEqual([]);
	});

	it('asks www.dwd.de for no forecast while a TEMSI serves the flight’s start', async () => {
		const urls: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn((url: string) => {
				urls.push(url);
				return Promise.resolve(new Response(PNG));
			}),
		);
		const doc = await fetchFrontCharts({
			proxyBase: PROXY,
			index: index({ analyses: analysesFromNames([NAME]), forecasts: FORECASTS_02 }),
			windowStartMs: at(2, 10),
			windowEndMs: at(2, 13),
			nowMs: at(2, 8),
			forecasts: false,
		});
		expect(urls).toEqual([`${PROXY}/dwd/charts/analysis/${NAME}`]);
		expect(doc.entries.map((e) => e.chart.kind)).toEqual(['analysis']);
		expect(doc.notes).toEqual([]);
	});

	it('records a chart that is not a PNG as failed, with why', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve(new Response('<html>error</html>', { status: 200 }))),
		);
		const doc = await fetchFrontCharts({
			proxyBase: PROXY,
			index: index({ analyses: analysesFromNames([NAME]) }),
			windowStartMs: at(2, 6),
			windowEndMs: at(2, 8),
			nowMs: at(2, 8),
		});
		expect(doc.entries).toEqual([]);
		expect(doc.failed.map((f) => f.failure.code)).toEqual(['notImage']);
	});
});
