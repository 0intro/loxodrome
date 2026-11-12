/* Who answers a forecast (src/lib/weather/openMeteo.ts fetchWindColumns,
 * docs/wind-aloft.md "Data source"): a model of ours is asked of
 * nwp.loxodrome.fr, whose answers name the runs each column used; a failure
 * Open-Meteo can stand in for (a 5xx, the `disabled` lever among them, a
 * network error, a body that is not JSON) asks Open-Meteo the same thing at
 * once and opens a ten-minute circuit, which any answer of ours (a run poll
 * included) closes; a request it refuses goes to Open-Meteo too, the circuit
 * left closed; its 429 is a backoff and never a failover; a request too heavy
 * for one answer is asked again in the parts the service names; the points it
 * does not cover and the windows older than a week are Open-Meteo's. The
 * network is a stub answering from the URL; the timers are faked. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	MF_LEVELS,
	OpenMeteoError,
	fetchModelRun,
	fetchWindColumns,
	nwpAvailable,
	resetNwpCircuitForTest,
	type WindFetchOpts,
} from '$lib/weather/openMeteo';

const HOUR = 3600_000;
const T0 = Date.UTC(2026, 9, 6, 9);
const RUN = Date.UTC(2026, 9, 6, 6);

interface Sent {
	url: URL;
}

let sent: Sent[] = [];
/** How our service answers; Open-Meteo always answers columns. */
let ours: (url: URL) => Response | Promise<Response> = (url) => columns(url, { runs: { arome0025: RUN / 1000 } });

function columns(url: URL, extra: { runs?: Record<string, number>; unserved?: number[] } = {}): Response {
	const lats = (url.searchParams.get('latitude') ?? '').split(',').map(Number);
	const lons = (url.searchParams.get('longitude') ?? '').split(',').map(Number);
	const vars = (url.searchParams.get('hourly') ?? '').split(',');
	const start = Date.parse(`${url.searchParams.get('start_hour')}Z`);
	const end = Date.parse(`${url.searchParams.get('end_hour')}Z`);
	const time: number[] = [];
	for (let t = start; t <= end; t += HOUR) {
		time.push(t / 1000);
	}
	const locs = lats.map((lat, i) => ({
		latitude: lat,
		longitude: lons[i],
		elevation: 0,
		hourly: Object.fromEntries<number[]>([['time', time], ...vars.map((v): [string, number[]] => [v, time.map(() => 10)])]),
		...(extra.runs ? { x_runs: extra.runs } : {}),
		...(extra.unserved?.includes(i) ? { x_unserved: true } : {}),
	}));
	return new Response(JSON.stringify(locs.length === 1 ? locs[0] : locs), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	vi.setSystemTime(T0);
	resetNwpCircuitForTest();
	sent = [];
	ours = (url) => columns(url, { runs: { arome0025: RUN / 1000 } });
	vi.stubGlobal(
		'fetch',
		vi.fn((input: string) => {
			const url = new URL(input);
			sent.push({ url });
			if (url.host === 'nwp.loxodrome.fr') {
				return Promise.resolve(ours(url));
			}
			return Promise.resolve(columns(url));
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

const opts = (model: WindFetchOpts['model'] = 'auto_chain', startMs = T0): WindFetchOpts => ({
	model,
	startMs,
	endMs: startMs + 2 * HOUR,
	temps: true,
	nowMs: T0,
});

/** The call settled: each coalescing window it opens (ours, then
 *  Open-Meteo's on a failover) runs out under the faked timers. */
async function fetched(points: { lat: number; lon: number }[], o: WindFetchOpts) {
	let settled = false;
	const p = fetchWindColumns(points, o).finally(() => {
		settled = true;
	});
	// A rejection is the caller's to read once the timers have run.
	p.catch(() => undefined);
	for (let k = 0; k < 10 && !settled; k++) {
		await vi.advanceTimersByTimeAsync(300);
	}
	return p;
}

const PARIS = { lat: 48.85, lon: 2.35 };
const TOKYO = { lat: 35.6, lon: 139.7 };

function hosts(): string[] {
	return sent.map((s) => s.url.host);
}

describe('a model of ours', () => {
	it('is asked of our service, its columns naming the runs they used', async () => {
		const cols = await fetched([PARIS], opts());
		expect(hosts()).toEqual(['nwp.loxodrome.fr']);
		expect(sent[0].url.pathname).toBe('/v1/forecast');
		expect(sent[0].url.searchParams.get('models')).toBe('auto_chain');
		// The Météo-France ladder, to 300 hPa.
		const vars = sent[0].url.searchParams.get('hourly') ?? '';
		expect(vars).toContain('wind_speed_300hPa');
		expect(vars).toContain('wind_speed_750hPa');
		expect(cols[0].source).toBe('nwp');
		expect(cols[0].runs).toEqual({ arome0025: RUN });
	});

	it('asks our service alone for the ground under each hour', async () => {
		const o = { ...opts(), levelsHpa: [], surfacePressure: true, groundByHour: true };
		await fetched([PARIS], o);
		expect((sent[0].url.searchParams.get('hourly') ?? '').split(',')).toContain('elevation');
		sent = [];
		ours = () => new Response(JSON.stringify({ error: true, reason: 'disabled' }), { status: 503 });
		const cols = await fetched([PARIS], o);
		expect(hosts()).toEqual(['nwp.loxodrome.fr', 'api.open-meteo.com']);
		// Open-Meteo knows no hourly elevation: its surface stands at its own.
		expect((sent[1].url.searchParams.get('hourly') ?? '').split(',')).not.toContain('elevation');
		expect(cols[0].source).toBe('open-meteo');
	});

	it('a model Open-Meteo alone serves is asked of Open-Meteo', async () => {
		const cols = await fetched([PARIS], opts('icon_seamless'));
		expect(hosts()).toEqual(['api.open-meteo.com']);
		expect(cols[0].source).toBe('open-meteo');
		expect(cols[0].runs ?? null).toBeNull();
	});
});

describe('the failover', () => {
	it('asks Open-Meteo the same thing when our service is disabled, the chain per region', async () => {
		ours = () => new Response(JSON.stringify({ error: true, reason: 'disabled' }), { status: 503 });
		const cols = await fetched([PARIS, TOKYO], opts());
		expect(hosts()).toEqual(['nwp.loxodrome.fr', 'api.open-meteo.com', 'api.open-meteo.com']);
		const models = sent.slice(1).map((s) => s.url.searchParams.get('models'));
		expect(models.sort()).toEqual(['ecmwf_ifs025', 'meteofrance_seamless']);
		// The same ladder on Open-Meteo, whose levels a model lacks come back null.
		for (const s of sent.slice(1)) {
			const vars = s.url.searchParams.get('hourly') ?? '';
			for (const lv of MF_LEVELS) {
				expect(vars).toContain(`wind_speed_${lv}hPa`);
			}
		}
		expect(cols.map((c) => [c.lat, c.source])).toEqual([
			[PARIS.lat, 'open-meteo'],
			[TOKYO.lat, 'open-meteo'],
		]);
	});

	it('asks Open-Meteo’s IFS for a European window past Météo-France’s reach', async () => {
		ours = () => new Response(JSON.stringify({ error: true, reason: 'disabled' }), { status: 503 });
		// Five days out over Paris: Open-Meteo's meteofrance_seamless would
		// answer nulls past 102 h, where the chain goes on with IFS.
		const cols = await fetched([PARIS], opts('auto_chain', T0 + 120 * HOUR));
		expect(hosts()).toEqual(['nwp.loxodrome.fr', 'api.open-meteo.com']);
		expect(sent[1].url.searchParams.get('models')).toBe('ecmwf_ifs025');
		expect(cols[0].source).toBe('open-meteo');
	});

	it('opens a circuit: the next requests go straight to Open-Meteo, a run poll of ours closes it', async () => {
		ours = () => Promise.reject(new TypeError('Failed to fetch'));
		await fetched([PARIS], opts());
		expect(nwpAvailable(Date.now())).toBe(false);
		sent = [];
		ours = (url) => columns(url, { runs: { arome0025: RUN / 1000 } });
		await fetched([PARIS], opts('meteofrance_seamless'));
		expect(hosts()).toEqual(['api.open-meteo.com']);
		// Ten minutes on, ours is asked again.
		expect(nwpAvailable(Date.now() + 10 * 60_000)).toBe(true);
		// Any answer of ours closes it at once.
		ours = () =>
			new Response(JSON.stringify({ last_run_initialisation_time: RUN / 1000, crs_wkt: 'GEOGCRS[BBOX[37.5,-12,55.4,16]]' }), {
				status: 200,
			});
		expect((await fetchModelRun('arome0025'))?.initMs).toBe(RUN);
		expect(nwpAvailable(Date.now())).toBe(true);
	});

	it('polls an AROME-OM domain\'s runs from our service, as every member\'s', async () => {
		ours = () =>
			new Response(JSON.stringify({ last_run_initialisation_time: RUN / 1000, crs_wkt: 'GEOGCRS[BBOX[9.7,-75.3,22.9,-51.7]]' }), {
				status: 200,
			});
		const run = await fetchModelRun('aromeomantil');
		expect(hosts()).toEqual(['nwp.loxodrome.fr']);
		expect(sent[0].url.pathname).toBe('/v1/data/aromeomantil/static/meta.json');
		expect(run?.initMs).toBe(RUN);
	});

	it('fails over on a body that is not JSON, and answers short when Open-Meteo has none either', async () => {
		ours = () => new Response('<html>portal</html>', { status: 200 });
		vi.mocked(fetch).mockImplementation((input) => {
			const url = new URL(input as string);
			sent.push({ url });
			return Promise.resolve(new Response('<html>portal</html>', { status: 200 }));
		});
		const cols = await fetched([PARIS], opts());
		expect(hosts()).toEqual(['nwp.loxodrome.fr', 'api.open-meteo.com']);
		expect(cols).toHaveLength(0);
	});

	it('never on a rate limit, which is a backoff', async () => {
		ours = () => new Response(JSON.stringify({ error: true, reason: 'rate limited' }), { status: 429 });
		const limited = await fetched([PARIS], opts()).catch((e: unknown) => e);
		expect(limited).toBeInstanceOf(OpenMeteoError);
		expect((limited as OpenMeteoError).rateLimited).toBe(true);
		expect((limited as OpenMeteoError).failover).toBe(false);
		expect(hosts()).toEqual(['nwp.loxodrome.fr']);
		expect(nwpAvailable(Date.now())).toBe(true);
	});

	it('fails over past the 8 s it gives our service, and shuts it out for ten minutes', async () => {
		// AbortSignal.timeout runs on the real clock: one on the faked one.
		const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
			const c = new AbortController();
			setTimeout(() => c.abort(new DOMException('timed out', 'TimeoutError')), ms);
			return c.signal;
		});
		// An answer that never comes: the client's own timeout ends it.
		vi.mocked(fetch).mockImplementation((input, init) => {
			const url = new URL(input as string);
			sent.push({ url });
			if (url.host !== 'nwp.loxodrome.fr') {
				return Promise.resolve(columns(url));
			}
			return new Promise<Response>((_, reject) => {
				init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')));
			});
		});
		let done = false;
		const p = fetchWindColumns([PARIS], opts()).finally(() => {
			done = true;
		});
		let cols: Awaited<typeof p>;
		try {
			for (let k = 0; k < 60 && !done; k++) {
				await vi.advanceTimersByTimeAsync(300);
			}
			// Settled inside 18 s of the faked clock, not by the test's own timeout.
			expect(done).toBe(true);
			cols = await p;
		} finally {
			timeout.mockRestore();
		}
		expect(hosts()).toEqual(['nwp.loxodrome.fr', 'api.open-meteo.com']);
		expect(cols[0].source).toBe('open-meteo');
		expect(nwpAvailable(Date.now())).toBe(false);
	});

	it('an aborted call neither fails over nor shuts our service out', async () => {
		vi.mocked(fetch).mockImplementation((input, init) => {
			const url = new URL(input as string);
			sent.push({ url });
			return new Promise<Response>((_, reject) => {
				init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
			});
		});
		const ctrl = new AbortController();
		const p = fetchWindColumns([PARIS], { ...opts(), signal: ctrl.signal });
		p.catch(() => undefined);
		await vi.advanceTimersByTimeAsync(300);
		ctrl.abort();
		await expect(p).rejects.toMatchObject({ name: 'AbortError' });
		await vi.advanceTimersByTimeAsync(300);
		expect(hosts()).toEqual(['nwp.loxodrome.fr']);
		expect(nwpAvailable(Date.now())).toBe(true);
	});

	it('a slow request failing after a later one succeeded opens no circuit', async () => {
		// The slow one asks the temperatures, the quick one not: two requests.
		ours = (url) => {
			if ((url.searchParams.get('hourly') ?? '').includes('temperature_')) {
				return new Promise((resolve) => {
					setTimeout(() => resolve(new Response(JSON.stringify({ error: true, reason: 'timeout' }), { status: 503 })), 2000);
				});
			}
			return columns(url, { runs: { arome0025: RUN / 1000 } });
		};
		const slow = fetched([PARIS], opts());
		const quick = fetched([TOKYO], { ...opts(), temps: false });
		const [slowCols, quickCols] = await Promise.all([slow, quick]);
		expect(quickCols[0].source).toBe('nwp');
		// The slow one still went to Open-Meteo, but the service answered
		// after it left: the next request is the service's own.
		expect(slowCols[0].source).toBe('open-meteo');
		expect(nwpAvailable(Date.now())).toBe(true);
	});

	it('asks Open-Meteo for a request our service refuses, leaving the circuit closed', async () => {
		// A client newer than the service, asking what it does not serve.
		ours = () => new Response(JSON.stringify({ error: true, reason: 'Unsupported variable x' }), { status: 400 });
		const cols = await fetched([PARIS], opts());
		expect(hosts()).toEqual(['nwp.loxodrome.fr', 'api.open-meteo.com']);
		expect(cols[0].source).toBe('open-meteo');
		// The service is up: the next request is its own again.
		expect(nwpAvailable(Date.now())).toBe(true);
	});
});

describe('a request too heavy for one answer', () => {
	/** Our service splitting any request of more than `most` points in
	 *  halves, as its read estimate would. */
	function splitting(most: number): (url: URL) => Response {
		return (url) => {
			const n = (url.searchParams.get('latitude') ?? '').split(',').length;
			if (n > most) {
				return new Response(JSON.stringify({ error: true, reason: 'The request needs too many reads', x_split: 2 }), {
					status: 400,
				});
			}
			return columns(url, { runs: { arome0025: RUN / 1000 } });
		};
	}
	const route = Array.from({ length: 7 }, (_, k) => ({ lat: 43 + k * 0.5, lon: 1 + k * 0.25 }));

	it('is asked again in the parts the service names, side by side, every column in its place', async () => {
		ours = splitting(4);
		const cols = await fetched(route, opts());
		const asked = sent.map((s) => (s.url.searchParams.get('latitude') ?? '').split(',').length);
		// 7 refused, then 3 and 4.
		expect(asked).toEqual([7, 3, 4]);
		expect(hosts().every((h) => h === 'nwp.loxodrome.fr')).toBe(true);
		expect(cols.map((c) => c.lat)).toEqual(route.map((p) => p.lat));
		expect(cols.every((c) => c.source === 'nwp')).toBe(true);
		expect(nwpAvailable(Date.now())).toBe(true);
	});

	it('splits a part again when it is still too heavy', async () => {
		ours = splitting(2);
		const cols = await fetched(route, opts());
		const asked = sent.map((s) => (s.url.searchParams.get('latitude') ?? '').split(',').length);
		expect(asked.slice(0, 3)).toEqual([7, 3, 4]);
		expect(asked.filter((n) => n <= 2).reduce((a, b) => a + b, 0)).toBe(7);
		expect(cols.map((c) => c.lat)).toEqual(route.map((p) => p.lat));
	});

	it('answers short when a part comes back short', async () => {
		ours = (url) => {
			const lats = (url.searchParams.get('latitude') ?? '').split(',');
			if (lats.length > 4) {
				return new Response(JSON.stringify({ error: true, reason: 'too many reads', x_split: 2 }), { status: 400 });
			}
			// A body cut short: one column fewer than asked.
			const full = columns(url, { runs: { arome0025: RUN / 1000 } });
			return lats.length === 4
				? new Response(JSON.stringify([]), { status: 200 })
				: full;
		};
		const cols = await fetched(route, opts());
		expect(cols).toHaveLength(0);
	});

	it('a single point split, which the service never asks, goes to Open-Meteo', async () => {
		ours = () => new Response(JSON.stringify({ error: true, reason: 'too many reads', x_split: 2 }), { status: 400 });
		const cols = await fetched([PARIS], opts());
		expect(hosts()).toEqual(['nwp.loxodrome.fr', 'api.open-meteo.com']);
		expect(cols[0].source).toBe('open-meteo');
		expect(nwpAvailable(Date.now())).toBe(true);
	});
});

describe('what our service does not serve', () => {
	it('asks Open-Meteo for the points it leaves unserved, keeping the rest', async () => {
		ours = (url) => columns(url, { runs: { arpege01: RUN / 1000 }, unserved: [1] });
		const cols = await fetched([PARIS, TOKYO], opts('meteofrance_seamless'));
		expect(hosts()).toEqual(['nwp.loxodrome.fr', 'api.open-meteo.com']);
		expect(sent[1].url.searchParams.get('latitude')).toBe(TOKYO.lat.toFixed(4));
		expect(sent[1].url.searchParams.get('models')).toBe('meteofrance_seamless');
		expect(cols.map((c) => c.source)).toEqual(['nwp', 'open-meteo']);
	});

	it('answers short when Open-Meteo cannot fill them, never keeping an unserved column', async () => {
		ours = (url) => columns(url, { runs: { arpege01: RUN / 1000 }, unserved: [1] });
		vi.mocked(fetch).mockImplementation((input) => {
			const url = new URL(input as string);
			sent.push({ url });
			return Promise.resolve(
				url.host === 'nwp.loxodrome.fr' ? ours(url) : new Response('<html>portal</html>', { status: 200 }),
			);
		});
		const cols = await fetched([PARIS, TOKYO], opts('meteofrance_seamless'));
		expect(hosts()).toEqual(['nwp.loxodrome.fr', 'api.open-meteo.com']);
		expect(cols).toHaveLength(0);
	});

	it('leaves a window starting more than a week back to Open-Meteo', async () => {
		const cols = await fetched([PARIS], opts('auto_chain', T0 - 8 * 24 * HOUR));
		expect(hosts()).toEqual(['api.open-meteo.com']);
		expect(sent[0].url.searchParams.get('models')).toBe('meteofrance_seamless');
		expect(cols[0].source).toBe('open-meteo');
		sent = [];
		await fetched([PARIS], opts('auto_chain', T0 - 6 * 24 * HOUR));
		expect(hosts()).toEqual(['nwp.loxodrome.fr']);
	});
});
