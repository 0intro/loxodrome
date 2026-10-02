/* How forecast requests leave (src/lib/weather/openMeteo.ts fetchWindColumns,
 * docs/wind-aloft.md "The request budget"): calls made together for the same
 * model and variables join one request, each distinct point asked once over
 * the union of their hours and each caller handed its own columns; at most
 * two requests are out at once; a call aborted before its request leaves
 * takes itself out of it, and a request nobody wants any more never leaves.
 * The network is a stub answering from the URL; the timers are faked. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HISTORICAL_BASE, OpenMeteoError, fetchWindColumns, type WindFetchOpts } from '$lib/weather/openMeteo';

const HOUR = 3600_000;
const T0 = Date.UTC(2026, 9, 2, 9);

interface Sent {
	url: URL;
	points: { lat: number; lon: number }[];
	release: () => void;
}

let sent: Sent[] = [];
let held = false;
let answer: (url: URL) => Response = (url) => columnsFor(url);

function columnsFor(url: URL, drop = 0): Response {
	const lats = (url.searchParams.get('latitude') ?? '').split(',').map(Number);
	const lons = (url.searchParams.get('longitude') ?? '').split(',').map(Number);
	const vars = (url.searchParams.get('hourly') ?? '').split(',');
	const start = Date.parse(`${url.searchParams.get('start_hour')}Z`);
	const end = Date.parse(`${url.searchParams.get('end_hour')}Z`);
	const time: number[] = [];
	for (let t = start; t <= end; t += HOUR) {
		time.push(t / 1000);
	}
	const locs = lats.slice(0, lats.length - drop).map((lat, i) => ({
		latitude: lat,
		longitude: lons[i],
		elevation: 0,
		hourly: Object.fromEntries<number[]>([['time', time], ...vars.map((v): [string, number[]] => [v, time.map(() => 10)])]),
	}));
	return new Response(JSON.stringify(locs.length === 1 ? locs[0] : locs), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	vi.setSystemTime(T0);
	sent = [];
	held = false;
	answer = (url) => columnsFor(url);
	vi.stubGlobal(
		'fetch',
		vi.fn((input: string) => {
			const url = new URL(input);
			const lats = (url.searchParams.get('latitude') ?? '').split(',').map(Number);
			const lons = (url.searchParams.get('longitude') ?? '').split(',').map(Number);
			let release: () => void = () => {};
			const gate = held ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
			sent.push({ url, points: lats.map((lat, i) => ({ lat, lon: lons[i] })), release: () => release() });
			return gate.then(() => answer(url));
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

const winds = (startH = 0, endH = 5): WindFetchOpts => ({
	model: 'meteofrance_seamless',
	startMs: T0 + startH * HOUR,
	endMs: T0 + endH * HOUR,
	temps: true,
	nowMs: T0,
});

/** The coalescing window passed and every promise callback run. */
async function leave(): Promise<void> {
	await vi.advanceTimersByTimeAsync(300);
}

describe('calls made together', () => {
	it('join one request: each point once, the union of their hours, each caller its own columns', async () => {
		const a = fetchWindColumns(
			[
				{ lat: 47, lon: 2 },
				{ lat: 48, lon: 2 },
			],
			winds(0, 5),
		);
		const b = fetchWindColumns(
			[
				{ lat: 48, lon: 2 },
				{ lat: 49, lon: 2 },
			],
			winds(3, 30),
		);
		await leave();
		expect(sent).toHaveLength(1);
		expect(sent[0].points).toEqual([
			{ lat: 47, lon: 2 },
			{ lat: 48, lon: 2 },
			{ lat: 49, lon: 2 },
		]);
		expect(sent[0].url.searchParams.get('start_hour')).toBe('2026-10-02T09:00');
		expect(sent[0].url.searchParams.get('end_hour')).toBe('2026-10-03T15:00');
		expect((await a).map((c) => c.lat)).toEqual([47, 48]);
		expect((await b).map((c) => c.lat)).toEqual([48, 49]);
	});

	it('stay apart when they ask for other variables, another model or another endpoint', async () => {
		void fetchWindColumns([{ lat: 47, lon: 2 }], winds());
		void fetchWindColumns([{ lat: 47, lon: 2 }], { ...winds(), temps: false, winds: false, clouds: true });
		void fetchWindColumns([{ lat: 47, lon: 2 }], { ...winds(), model: 'icon_seamless' });
		// Ninety days back: the historical endpoint.
		void fetchWindColumns([{ lat: 47, lon: 2 }], winds(-90 * 24, -90 * 24 + 5));
		await leave();
		await leave();
		expect(sent).toHaveLength(4);
		expect(sent.filter((s) => s.url.href.startsWith(HISTORICAL_BASE))).toHaveLength(1);
	});
});

describe('a call aborted before its request leaves', () => {
	it('takes its points out of the request', async () => {
		const ctrl = new AbortController();
		const gone = fetchWindColumns([{ lat: 50, lon: 2 }], { ...winds(), signal: ctrl.signal });
		const kept = fetchWindColumns([{ lat: 47, lon: 2 }], winds());
		ctrl.abort();
		await expect(gone).rejects.toMatchObject({ name: 'AbortError' });
		await leave();
		expect(sent).toHaveLength(1);
		expect(sent[0].points).toEqual([{ lat: 47, lon: 2 }]);
		expect(await kept).toHaveLength(1);
	});

	it('every caller gone, never leaves at all', async () => {
		const ctrl = new AbortController();
		const a = fetchWindColumns([{ lat: 47, lon: 2 }], { ...winds(), signal: ctrl.signal });
		const b = fetchWindColumns([{ lat: 48, lon: 2 }], { ...winds(), signal: ctrl.signal });
		ctrl.abort();
		await expect(a).rejects.toMatchObject({ name: 'AbortError' });
		await expect(b).rejects.toMatchObject({ name: 'AbortError' });
		await leave();
		expect(sent).toHaveLength(0);
	});

	it('already aborted, asks for nothing', async () => {
		const ctrl = new AbortController();
		ctrl.abort();
		await expect(fetchWindColumns([{ lat: 47, lon: 2 }], { ...winds(), signal: ctrl.signal })).rejects.toMatchObject({
			name: 'AbortError',
		});
		await leave();
		expect(sent).toHaveLength(0);
	});
});

describe('requests out at once', () => {
	it('are two at most, the rest leaving as they settle', async () => {
		held = true;
		const models = ['meteofrance_seamless', 'icon_seamless', 'gfs_seamless', 'ecmwf_ifs025', 'ukmo_seamless'] as const;
		const all = models.map((model) => fetchWindColumns([{ lat: 47, lon: 2 }], { ...winds(), model }));
		await leave();
		expect(sent).toHaveLength(2);
		sent[0].release();
		await leave();
		expect(sent).toHaveLength(3);
		held = false;
		for (const s of sent) {
			s.release();
		}
		await leave();
		for (const s of sent.slice(3)) {
			s.release();
		}
		await leave();
		expect(sent).toHaveLength(5);
		expect((await Promise.all(all)).every((cols) => cols.length === 1)).toBe(true);
	});

	it('carry two hundred points each, a whole map lattice in one', async () => {
		const points = Array.from({ length: 250 }, (_, i) => ({ lat: 40 + i * 0.05, lon: 2 }));
		const cols = fetchWindColumns(points, winds());
		await leave();
		expect(sent.map((s) => s.points.length)).toEqual([200, 50]);
		expect((await cols).map((c) => c.lat)).toEqual(points.map((p) => Number(p.lat.toFixed(4))));
	});
});

describe('what a request answers every caller', () => {
	it('a refusal, as the error it is', async () => {
		answer = () =>
			new Response(JSON.stringify({ error: true, reason: 'Minutely API request limit exceeded. Please try again in one minute.' }), {
				status: 429,
				headers: { 'content-type': 'application/json' },
			});
		const a = fetchWindColumns([{ lat: 47, lon: 2 }], winds());
		const b = fetchWindColumns([{ lat: 48, lon: 2 }], winds());
		const caught = Promise.allSettled([a, b]);
		await leave();
		const [ra, rb] = await caught;
		for (const r of [ra, rb]) {
			expect(r.status).toBe('rejected');
			const err = (r as PromiseRejectedResult).reason as OpenMeteoError;
			expect(err).toBeInstanceOf(OpenMeteoError);
			expect(err.rateLimited).toBe(true);
		}
	});

	it('a short answer, short for everyone', async () => {
		answer = (url) => columnsFor(url, 1);
		const a = fetchWindColumns([{ lat: 47, lon: 2 }], winds());
		const b = fetchWindColumns([{ lat: 48, lon: 2 }], winds());
		await leave();
		expect(await a).toEqual([]);
		expect(await b).toEqual([]);
	});
});
