/* A fake forecast for the specs that run a real pass of the per-route
 * forecast cache (state/routeWind.svelte.ts): the module's own exports, with
 * fetchWindColumns answered from `fake`, one column per requested point,
 * hourly over the requested window. A model our service answers comes back
 * as ours does, naming the runs it used (x_runs): every one of the model's
 * run directories whose run the fake knows, or `fake.served` when a spec
 * says which. Install it from a vi.mock factory, which
 * may only reach this module through an import of its own:
 *
 *   vi.mock('$lib/weather/openMeteo', async (orig) =>
 *     (await import('./helpers/fakeOpenMeteo')).withFakeColumns(await orig()));
 *
 * and steer it through the same module's `fake`. */
import type * as OpenMeteo from '$lib/weather/openMeteo';
import type { WindColumn, WindFetchOpts } from '$lib/weather/openMeteo';
import type { Bbox, DirRun } from '$lib/weather/forecastCache';

const HOUR = 3600_000;

export const fake = {
	/** The [direction, speed] of the column for request point `i`, or null
	 *  for a column with no hours at all (a leg the forecast cannot serve). */
	windAt: (_i: number): [number, number] | null => [250, 20],
	/** Holds every answer until resolved: the fetch in flight. */
	hold: null as Promise<void> | null,
	/** Holds, in turn, the answer of each call made next: one fetch stays in
	 *  flight while the one after it answers. */
	holds: [] as Promise<void>[],
	/** Fails every call as a network error would. */
	fail: false,
	/** Refuses every call as the endpoint's minute window does: the module
	 *  then arms its backoff timer, which a spec must run out. */
	rateLimited: false,
	/** Answers every call with no columns: a 200 whose body decodes to
	 *  nothing, a captive portal's page or a body cut short. */
	empty: false,
	/** Calls made, and the window each asked for, oldest first. */
	calls: 0,
	windows: [] as { startMs: number; endMs: number }[],
	/** Every call's points and options, oldest first. */
	requests: [] as { points: { lat: number; lon: number }[]; opts: WindFetchOpts }[],
	/** What Open-Meteo would have charged for the calls made, by its own
	 *  rule (openMeteo.ts requestWeight over the variables asked for). */
	weight: 0,
	/** The model run the run-info poll answers for every directory; null
	 *  answers nothing, as a poll offline does. */
	runMs: null as number | null,
	/** A directory's own run, over runMs (undefined: runMs; null: nothing). */
	runs: {} as Record<string, number | null | undefined>,
	/** A directory's grid (no entry: unknown, holding every point; an
	 *  AROME-OM domain's own box unless set, so it never holds a European
	 *  point: omBox). */
	bboxes: {} as Record<string, Bbox | undefined>,
	/** Run polls made, by directory. */
	polls: {} as Record<string, number>,
	/** The runs our service's columns say they used (x_runs), over the
	 *  default (every run directory of the model the fake knows a run for). */
	served: null as Record<string, number> | null,
	/** The surface fields a Surface-mode request carries: the 2 m
	 *  temperature (degC) and the surface pressure (hPa). */
	surface: { tempC: 12, pressureHpa: 980 },
	/** The temperatures (degC) of the two ladder levels, 925 hPa at 800 m and
	 *  850 hPa at 1500 m: above freezing by default; [3, -4] puts the
	 *  freezing level at 1100 m. */
	temps: [5, 2] as [number, number],
	reset(): void {
		fake.windAt = () => [250, 20];
		fake.hold = null;
		fake.holds = [];
		fake.fail = false;
		fake.rateLimited = false;
		fake.empty = false;
		fake.calls = 0;
		fake.windows = [];
		fake.requests = [];
		fake.weight = 0;
		fake.runMs = null;
		fake.runs = {};
		fake.bboxes = {};
		fake.polls = {};
		fake.served = null;
		fake.surface = { tempC: 12, pressureHpa: 980 };
		fake.temps = [5, 2];
	},
};

/** A column holding one wind at both ladder levels and at 10 m, hourly over
 *  the window with both ends included, as the endpoint answers its
 *  start_hour..end_hour (a fake answering an hour more would read coverage
 *  more leniently than production). As the endpoint does, it carries what
 *  the request asked for: the winds unless `winds` is false (the route's
 *  cloud columns), cloud cover when `clouds` is set (a broken layer at
 *  850 hPa, none at 925). */
export function fakeColumn(
	p: { lat: number; lon: number },
	wind: [number, number] | null,
	startMs: number,
	endMs: number,
	asked: {
		winds?: boolean | undefined;
		clouds?: boolean | undefined;
		surface?: boolean | undefined;
		surfacePressure?: boolean | undefined;
	} = {},
): WindColumn {
	const t0 = Math.floor(startMs / HOUR) * HOUR;
	const n = wind ? Math.floor((endMs - t0) / HOUR) + 1 : 0;
	const [dir, spd] = wind ?? [0, 0];
	const fill = (v: number): number[] => new Array<number>(n).fill(v);
	const hourly: Record<string, number[]> = {
		geopotential_height_925hPa: fill(800),
		geopotential_height_850hPa: fill(1500),
	};
	if (asked.winds !== false) {
		Object.assign(hourly, {
			wind_speed_925hPa: fill(spd),
			wind_direction_925hPa: fill(dir),
			temperature_925hPa: fill(fake.temps[0]),
			wind_speed_850hPa: fill(spd),
			wind_direction_850hPa: fill(dir),
			temperature_850hPa: fill(fake.temps[1]),
			wind_speed_10m: fill(spd),
			wind_direction_10m: fill(dir),
		});
	}
	if (asked.clouds) {
		Object.assign(hourly, { cloud_cover_925hPa: fill(0), cloud_cover_850hPa: fill(70) });
	}
	if (asked.surface) {
		Object.assign(hourly, { wind_gusts_10m: fill(spd), temperature_2m: fill(fake.surface.tempC) });
	}
	if (asked.surfacePressure) {
		hourly.surface_pressure = fill(fake.surface.pressureHpa);
	}
	return {
		lat: p.lat,
		lon: p.lon,
		elevationM: 0,
		timesMs: Array.from({ length: n }, (_, k) => t0 + k * HOUR),
		hourly,
	};
}

/** An AROME-OM domain's own grid, as the service states it. */
function omBox(actual: typeof OpenMeteo, dir: string): Bbox | undefined {
	const box = actual.NWP_MEMBERS.find((m) => m.dir === dir && m.name === 'AROME-OM')?.box;
	return box ? [box.south, box.west, box.north, box.east] : undefined;
}

export function withFakeColumns(actual: typeof OpenMeteo): typeof OpenMeteo {
	return {
		...actual,
		fetchWindColumns: async (points, opts) => {
			fake.calls++;
			fake.windows.push({ startMs: opts.startMs, endMs: opts.endMs });
			fake.requests.push({ points: points.map((p) => ({ lat: p.lat, lon: p.lon })), opts });
			const days = (opts.endMs - opts.startMs + HOUR) / (24 * HOUR);
			const variables = actual.hourlyVariables(actual.windModel(opts.model), opts).length;
			fake.weight += actual.requestWeight(points.length, variables, days);
			const own = fake.holds.shift();
			if (fake.hold) {
				await fake.hold;
			}
			if (own) {
				await own;
			}
			if (fake.rateLimited) {
				throw new actual.OpenMeteoError('open-meteo fetch failed: Minutely API request limit exceeded', {
					rateLimited: true,
				});
			}
			if (fake.fail) {
				// A plain failure: a rate-limited one would arm the module's
				// retry timer and hold every later case behind it.
				throw new Error('forecast unreachable');
			}
			if (fake.empty) {
				return [];
			}
			const spec = actual.windModel(opts.model);
			// Our service names, per point, the members whose grid holds it.
			const servedAt = (p: { lat: number; lon: number }): Record<string, number> | null => {
				if (spec.transport !== 'nwp') {
					return null;
				}
				if (fake.served) {
					return { ...fake.served };
				}
				const out: Record<string, number> = {};
				for (const dir of spec.runDirs.flat()) {
					const own = fake.runs[dir];
					const run = own === undefined ? fake.runMs : own;
					const b = fake.bboxes[dir] ?? omBox(actual, dir);
					const inside = !b || (p.lat >= b[0] && p.lat <= b[2] && p.lon >= b[1] && p.lon <= b[3]);
					if (run != null && inside) {
						out[dir] = run;
					}
				}
				return out;
			};
			return points.map((p, i) => {
				const col = fakeColumn(p, fake.windAt(i), opts.startMs, opts.endMs, opts);
				const served = servedAt(p);
				return served ? { ...col, source: 'nwp' as const, runs: served } : col;
			});
		},
		fetchModelRun: (dir: string): Promise<DirRun | null> => {
			fake.polls[dir] = (fake.polls[dir] ?? 0) + 1;
			const own = fake.runs[dir];
			const initMs = own === undefined ? fake.runMs : own;
			return Promise.resolve(initMs == null ? null : { initMs, bbox: fake.bboxes[dir] ?? omBox(actual, dir) ?? null, intervalMs: null });
		},
	};
}
