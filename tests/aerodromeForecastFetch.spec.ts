/* When the performance page's aerodrome forecast is asked again
 * (state/aerodromeForecast.svelte.ts ensureAerodromeForecast): never while
 * what is held covers the hours wanted, the hours wanted ending where the
 * endpoint's range does (a phase past it was asked again every minute); and
 * a call for other hours made while a request is out is looked at again
 * once that request lands, rather than taking its answer for its own. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from './helpers/storage';

vi.stubGlobal('localStorage', memoryStorage());

const HOUR = 3600_000;
const T0 = Date.UTC(2026, 9, 7, 9);
const RUN = Date.UTC(2026, 9, 7, 6) / 1000;

const { setLiveWeather } = await import('$lib/state/display.svelte');
const af = await import('$lib/state/aerodromeForecast.svelte');
const { forecastRangeEndMs } = await import('$lib/weather/openMeteo');
const w = await import('$lib/state/windAloft.svelte');

let asked: URL[] = [];

function columns(url: URL): Response {
	const vars = (url.searchParams.get('hourly') ?? '').split(',');
	const start = Date.parse(`${url.searchParams.get('start_hour')}Z`);
	const end = Date.parse(`${url.searchParams.get('end_hour')}Z`);
	const time: number[] = [];
	for (let t = start; t <= end; t += HOUR) {
		time.push(t / 1000);
	}
	return new Response(
		JSON.stringify({
			latitude: 48.82,
			longitude: 2.62,
			elevation: 102,
			hourly: Object.fromEntries<number[]>([['time', time], ...vars.map((v): [string, number[]] => [v, time.map(() => 10)])]),
			x_runs: { arome0025: RUN + 1 },
			x_latest: { arome0025: RUN + 1 },
		}),
		{ status: 200 },
	);
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	vi.setSystemTime(T0);
	setLiveWeather(true);
	af.resetAerodromeForecastsForTest();
	w.resetWindAloftForTest();
	asked = [];
	vi.stubGlobal(
		'fetch',
		vi.fn((input: string) => {
			const url = new URL(input);
			if (url.pathname.endsWith('/meta.json')) {
				return Promise.resolve(new Response(JSON.stringify({ last_run_initialisation_time: RUN + 1 }), { status: 200 }));
			}
			asked.push(url);
			return Promise.resolve(columns(url));
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.stubGlobal('localStorage', memoryStorage());
	vi.useRealTimers();
});

/** One ensure, run to its end under the faked timers. */
async function ensure(fromMs: number, toMs: number): Promise<void> {
	let done = false;
	const p = af.ensureAerodromeForecast('LFPL', 48.82194, 2.62278, fromMs, toMs, { nowMs: Date.now() }).finally(() => {
		done = true;
	});
	for (let k = 0; k < 20 && !done; k++) {
		await vi.advanceTimersByTimeAsync(300);
	}
	await p;
}

describe('the aerodrome forecast', () => {
	it('is not asked again for a phase past the endpoint\'s range', async () => {
		const end = forecastRangeEndMs(T0);
		await ensure(end - 2 * HOUR, end + 3 * HOUR);
		await ensure(end - 2 * HOUR, end + 3 * HOUR);
		const forecasts = asked.filter((u) => u.pathname === '/v1/forecast');
		expect(forecasts).toHaveLength(1);
	});

	it('asked for other hours while a request is out, gets them once it lands', async () => {
		const first = af.ensureAerodromeForecast('LFPL', 48.82194, 2.62278, T0, T0 + 2 * HOUR, { nowMs: T0 });
		const later = af.ensureAerodromeForecast('LFPL', 48.82194, 2.62278, T0 + 30 * HOUR, T0 + 32 * HOUR, { nowMs: T0 });
		let settled = false;
		void Promise.all([first, later]).finally(() => {
			settled = true;
		});
		for (let k = 0; k < 40 && !settled; k++) {
			await vi.advanceTimersByTimeAsync(300);
		}
		expect(settled).toBe(true);
		expect(af.aerodromeForecastAt('LFPL', T0 + 31 * HOUR)).not.toBeNull();
	});
});
